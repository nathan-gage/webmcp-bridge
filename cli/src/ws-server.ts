/**
 * WebSocket server for the CLI bridge.
 * Accepts connections from the Chrome extension, routes messages,
 * and manages tool registration and execution.
 *
 * Hybrid model: Extension pushes register_tools for instant caching.
 * CLI also supports get_tools/tools_list for on-demand queries.
 * getTools() returns from cache — no round-trip needed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ToolSchema, ExecuteToolMessage, WireMessage, ToolResultMessage } from "./protocol.js";
import { isRegisterTools, isToolsChanged, isToolsList, isToolResult } from "./protocol.js";
import { generateToken, validateOrigin } from "./security.js";

const TOOL_CALL_TIMEOUT_MS = 30_000;
const WAIT_FOR_CONNECTION_POLL_MS = 200;
const PORT_RANGE_START = 13100;
const PORT_RANGE_END = 13199;
const WS_PING_INTERVAL_MS = 20_000;

interface PendingCall {
  resolve: (result: ToolResultMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
}

export interface WsServerOptions {
  /** Override token for testing */
  token?: string;
  /** Override port for testing (0 for random) */
  port?: number;
}

export interface WsServer {
  /** The port the server is listening on */
  port: number;
  /** The authentication token */
  token: string;
  /** Get cached tools from the extension (instant, no round-trip) */
  getTools(): ToolSchema[];
  /** Whether an extension client is connected */
  isExtensionConnected(): boolean;
  /** Execute a tool on the extension, returns the result */
  executeTool(name: string, args: Record<string, unknown>): Promise<ToolResultMessage>;
  /** Register a callback for when the tool list changes */
  onToolsChanged(cb: () => void): void;
  /** Wait for extension to connect, polling every 200ms up to timeoutMs */
  waitForConnection(timeoutMs: number): Promise<boolean>;
  /** Gracefully shut down the server */
  close(): Promise<void>;
}

export async function createWsServer(options: WsServerOptions = {}): Promise<WsServer> {
  const token = options.token ?? generateToken();
  let tools: ToolSchema[] = [];
  let extensionWs: WebSocket | null = null;
  const pendingCalls = new Map<string, PendingCall>();
  const toolsChangedCallbacks: Array<() => void> = [];

  // HTTP server for bootstrap endpoint + WebSocket upgrade
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/.well-known/webmcp-bridge") {
      const origin = req.headers.origin ?? "";
      if (!validateOrigin(origin)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ token }));
      return;
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin ?? "";
      if (validateOrigin(origin)) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "3600",
        });
        res.end();
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const reqToken = url.searchParams.get("token");

    if (reqToken !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  let pingInterval: ReturnType<typeof setInterval> | null = null;

  wss.on("connection", (ws: WebSocket) => {
    // Only allow one extension connection at a time
    if (extensionWs) {
      process.stderr.write("[webmcp] Extension replaced by new connection\n");
      extensionWs.close(1000, "replaced");
      clearPendingCalls("extension replaced");
    }
    if (pingInterval) clearInterval(pingInterval);
    extensionWs = ws;
    process.stderr.write("[webmcp] Extension connected\n");

    // Server-side ping to keep the connection alive and detect dead sockets.
    // The browser auto-responds with pong frames at the WebSocket protocol level.
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    pingInterval = setInterval(() => {
      if (!alive) {
        process.stderr.write("[webmcp] Extension ping timeout — terminating\n");
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, WS_PING_INTERVAL_MS);

    ws.on("message", (data) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(String(data)) as WireMessage;
      } catch {
        return; // ignore malformed messages
      }

      if (isRegisterTools(msg)) {
        // Push: extension sends full tool list — cache it
        tools = msg.tools;

        // Don't reject pending calls when tools change — the result may still
        // arrive (e.g. SPA navigation re-registers tools while an async execute
        // callback is still in flight). The existing 30s timeout handles the
        // failure case if the result truly never comes.

        process.stderr.write(
          `[webmcp] Tools registered: ${tools.length} tool(s)${tools.length > 0 ? ` [${tools.map((t) => t.name).join(", ")}]` : ""}\n`,
        );
        for (const cb of toolsChangedCallbacks) {
          cb();
        }
      } else if (isToolsChanged(msg)) {
        // Hint-only: tools may have changed but no payload — just notify
        process.stderr.write("[webmcp] Tools changed hint received\n");
        for (const cb of toolsChangedCallbacks) {
          cb();
        }
      } else if (isToolsList(msg)) {
        // Response to a get_tools request (unused in normal flow, but supported)
        process.stderr.write(`[webmcp] tools_list response: ${msg.tools.length} tool(s)\n`);
      } else if (isToolResult(msg)) {
        const pending = pendingCalls.get(msg.callId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCalls.delete(msg.callId);
          pending.resolve(msg);
        }
      }
    });

    ws.on("close", () => {
      if (extensionWs === ws) {
        process.stderr.write("[webmcp] Extension disconnected\n");
        extensionWs = null;
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        clearPendingCalls("extension disconnected");
        // Keep tools cached — don't clear on disconnect.
        // The extension will re-push fresh tools when it reconnects.
        // This prevents tool list from flickering during brief disconnects
        // (service worker suspension, navigation, CLI restart, etc.)
      }
    });

    ws.on("error", () => {
      // Connection errors are handled by the close event
    });
  });

  function clearPendingCalls(reason: string) {
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      pendingCalls.delete(id);
    }
  }

  async function executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResultMessage> {
    // If not connected, wait briefly for reconnection (tolerates transient disconnects during navigation)
    if (!extensionWs || extensionWs.readyState !== extensionWs.OPEN) {
      const reconnected = await waitForConnection(5000);
      if (!reconnected) {
        throw new Error("No extension connected");
      }
    }

    return new Promise((resolve, reject) => {
      if (!extensionWs || extensionWs.readyState !== extensionWs.OPEN) {
        reject(new Error("No extension connected"));
        return;
      }

      const callId = randomUUID();
      const timer = setTimeout(() => {
        pendingCalls.delete(callId);
        reject(new Error(`Tool call "${name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms`));
      }, TOOL_CALL_TIMEOUT_MS);

      pendingCalls.set(callId, { resolve, reject, timer, toolName: name });

      const msg: ExecuteToolMessage = {
        type: "execute_tool",
        callId,
        name,
        arguments: args,
      };

      extensionWs.send(JSON.stringify(msg));
    });
  }

  function waitForConnection(timeoutMs: number): Promise<boolean> {
    if (extensionWs && extensionWs.readyState === extensionWs.OPEN) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const interval = setInterval(() => {
        if (extensionWs && extensionWs.readyState === extensionWs.OPEN) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve(false);
        }
      }, WAIT_FOR_CONNECTION_POLL_MS);
    });
  }

  // Bind to random port in range
  const port = await new Promise<number>((resolve, reject) => {
    if (options.port !== undefined) {
      httpServer.listen(options.port, "127.0.0.1", () => {
        const addr = httpServer.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
      return;
    }

    // Try random ports in the range
    const tryPort = (attempt: number) => {
      if (attempt > 50) {
        reject(new Error("Failed to bind to a port in range 13100-13199"));
        return;
      }
      const candidatePort =
        PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START + 1));

      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          tryPort(attempt + 1);
        } else {
          reject(err);
        }
      });

      httpServer.listen(candidatePort, "127.0.0.1", () => {
        resolve(candidatePort);
      });
    };

    tryPort(0);
  });

  return {
    port,
    token,
    getTools: () => tools,
    isExtensionConnected: () => extensionWs !== null && extensionWs.readyState === extensionWs.OPEN,
    executeTool,
    onToolsChanged: (cb) => {
      toolsChangedCallbacks.push(cb);
    },
    waitForConnection,
    close: () =>
      new Promise<void>((resolve) => {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        clearPendingCalls("server shutting down");
        // Force close all WebSocket connections first
        for (const client of wss.clients) {
          client.terminate();
        }
        // Close servers - use terminate approach to avoid hanging
        wss.close();
        httpServer.close(() => resolve());
        // Safety timeout to prevent hanging
        setTimeout(() => resolve(), 500);
      }),
  };
}
