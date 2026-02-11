/**
 * MCP stdio server that bridges tool calls to the WebSocket extension.
 * Uses the low-level Server class to avoid Zod schema validation —
 * WebMCP tools provide plain JSON Schema, not Zod schemas.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WsServer } from "./ws-server.js";

const DEBOUNCE_MS = 200;

export interface McpBridgeServer {
  /** Start the MCP server. Uses stdio by default, or a custom transport for testing. */
  start(transport?: Transport): Promise<void>;
  /** Notify the MCP client that the tool list has changed */
  notifyToolsChanged(): void;
  /** Close the MCP server */
  close(): Promise<void>;
}

export function createMcpServer(wsServer: WsServer): McpBridgeServer {
  const server = new Server(
    { name: "webmcp-bridge", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  // --- tools/list handler ---
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const extensionTools = wsServer.getTools();

    const tools = [
      // Built-in status tool
      {
        name: "webmcp-status",
        description: "Show the current WebMCP bridge connection status",
        inputSchema: { type: "object" as const, properties: {} },
      },
      // Dynamic tools from the extension
      ...extensionTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: "object" as const, ...t.inputSchema },
      })),
    ];

    return { tools };
  });

  // --- tools/call handler ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Built-in status tool
    if (name === "webmcp-status") {
      const connected = wsServer.isExtensionConnected();
      const tools = wsServer.getTools();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                connected,
                toolCount: tools.length,
                tools: tools.map((t) => t.name),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Forward to extension
    try {
      const result = await wsServer.executeTool(name, args as Record<string, unknown>);

      if (result.isError || result.error) {
        return {
          content: [
            {
              type: "text" as const,
              text: result.error ?? "Unknown error",
            },
          ],
          isError: true,
        };
      }

      const text =
        typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result ?? null, null, 2);

      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  });

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    async start(customTransport?: Transport) {
      // Wire up tool change notifications with debounce.
      // During page navigation, the extension rapidly sends tool updates.
      // Debouncing collapses these into a single notification.
      wsServer.onToolsChanged(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // sendToolListChanged() is async — catch both sync throws and rejections
          // to ignore "Not connected" errors during shutdown races
          try {
            server.sendToolListChanged().catch(() => {});
          } catch {
            // Ignore if transport is already disconnected
          }
        }, DEBOUNCE_MS);
      });

      const transport = customTransport ?? new StdioServerTransport();
      await server.connect(transport);
    },

    notifyToolsChanged() {
      server.sendToolListChanged();
    },

    async close() {
      clearTimeout(debounceTimer);
      await server.close();
    },
  };
}
