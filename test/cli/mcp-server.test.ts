/**
 * MCP server tests — exercises the real MCP protocol via InMemoryTransport.
 * Wires up: MCP Client ↔ InMemoryTransport ↔ McpServer ↔ WsServer ↔ mock extension WebSocket.
 *
 * Previous version of this file only tested mocks. This version verifies
 * the actual tools/list responses, tools/call forwarding, and notifications.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createWsServer, type WsServer } from "../../cli/src/ws-server.js";
import { createMcpServer, type McpBridgeServer } from "../../cli/src/mcp-server.js";
import type { RegisterToolsMessage, ExecuteToolMessage } from "../../cli/src/protocol.js";

let wsServer: WsServer;
let mcpServer: McpBridgeServer;
let mcpClient: Client;

afterEach(async () => {
  await mcpClient?.close().catch(() => {});
  await mcpServer?.close().catch(() => {});
  await wsServer?.close().catch(() => {});
});

/** Connect a mock extension WebSocket to the WS server */
function connectExtension(srv: WsServer): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?token=${srv.token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Send a register_tools message from the mock extension */
function registerTools(ext: WebSocket, tools: RegisterToolsMessage["tools"]) {
  ext.send(JSON.stringify({ type: "register_tools", tools }));
}

/** Create linked WsServer + McpServer + MCP Client connected via InMemoryTransport */
async function createTestStack() {
  wsServer = await createWsServer({ port: 0, token: "mcp-test" });
  mcpServer = createMcpServer(wsServer);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  mcpClient = new Client({ name: "test-client", version: "1.0.0" });

  await mcpServer.start(serverTransport);
  await mcpClient.connect(clientTransport);

  return { wsServer, mcpServer, mcpClient };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tools/list", () => {
  test("returns only webmcp-status when no extension connected", async () => {
    await createTestStack();

    const result = await mcpClient.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("webmcp-status");
  });

  test("returns extension tools after register_tools", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    registerTools(ext, [
      { name: "search", description: "Search the web", inputSchema: { type: "object" } },
    ]);
    await delay(50);

    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("webmcp-status");
    expect(names).toContain("search");

    ext.close();
  });

  test("returns multiple extension tools", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    registerTools(ext, [
      { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      { name: "tool_b", description: "B", inputSchema: { type: "object" } },
      { name: "tool_c", description: "C", inputSchema: { type: "object" } },
    ]);
    await delay(50);

    const result = await mcpClient.listTools();
    expect(result.tools).toHaveLength(4); // 3 + webmcp-status
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("tool_a");
    expect(names).toContain("tool_b");
    expect(names).toContain("tool_c");

    ext.close();
  });

  test("always includes type:'object' in inputSchema", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    // Tool with empty inputSchema (common with WebMCP tools)
    registerTools(ext, [{ name: "bare_tool", description: "Bare", inputSchema: {} }]);
    await delay(50);

    const result = await mcpClient.listTools();
    const bareTool = result.tools.find((t) => t.name === "bare_tool");
    expect(bareTool).toBeDefined();
    expect(bareTool!.inputSchema.type).toBe("object");

    ext.close();
  });

  test("tools update when extension re-registers", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    registerTools(ext, [{ name: "old_tool", description: "Old", inputSchema: { type: "object" } }]);
    await delay(50);

    let result = await mcpClient.listTools();
    expect(result.tools.map((t) => t.name)).toContain("old_tool");

    // Re-register with new tools
    registerTools(ext, [{ name: "new_tool", description: "New", inputSchema: { type: "object" } }]);
    await delay(50);

    result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("new_tool");
    expect(names).not.toContain("old_tool");

    ext.close();
  });

  test("tools preserved after extension disconnect", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    registerTools(ext, [
      { name: "cached_tool", description: "Cached", inputSchema: { type: "object" } },
    ]);
    await delay(50);

    ext.close();
    await delay(50);

    // Stale cache should still be available
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("cached_tool");
    expect(names).toContain("webmcp-status");
  });
});

describe("tools/list_changed notification", () => {
  test("fires when extension registers tools", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    let notificationCount = 0;
    mcpClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notificationCount++;
    });

    registerTools(ext, [
      { name: "test_tool", description: "Test", inputSchema: { type: "object" } },
    ]);

    // Notification is debounced (200ms in mcp-server)
    await delay(350);
    expect(notificationCount).toBeGreaterThanOrEqual(1);

    ext.close();
  });

  test("fires on tools_changed hint", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    let notificationCount = 0;
    mcpClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notificationCount++;
    });

    ext.send(JSON.stringify({ type: "tools_changed" }));
    await delay(350);

    expect(notificationCount).toBeGreaterThanOrEqual(1);

    ext.close();
  });

  test("client can re-fetch tools after notification", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    // Initially no extension tools
    let result = await mcpClient.listTools();
    expect(result.tools).toHaveLength(1);

    // Register tools and wait for notification to propagate
    registerTools(ext, [{ name: "new_tool", description: "New", inputSchema: { type: "object" } }]);
    await delay(350);

    // Re-fetch should show new tools
    result = await mcpClient.listTools();
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name)).toContain("new_tool");

    ext.close();
  });
});

describe("tools/call", () => {
  test("webmcp-status returns connection info", async () => {
    await createTestStack();

    const result = await mcpClient.callTool({ name: "webmcp-status", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const status = JSON.parse(text);

    expect(status.connected).toBe(false);
    expect(status.toolCount).toBe(0);
  });

  test("webmcp-status reflects extension tools", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    registerTools(ext, [{ name: "tool_x", description: "X", inputSchema: { type: "object" } }]);
    await delay(50);

    const result = await mcpClient.callTool({ name: "webmcp-status", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const status = JSON.parse(text);

    expect(status.connected).toBe(true);
    expect(status.toolCount).toBe(1);
    expect(status.tools).toContain("tool_x");

    ext.close();
  });

  test("forwards tool call to extension and returns result", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    registerTools(ext, [
      { name: "search", description: "Search", inputSchema: { type: "object" } },
    ]);
    await delay(50);

    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ExecuteToolMessage;
      if (msg.type === "execute_tool" && msg.name === "search") {
        ext.send(
          JSON.stringify({
            type: "tool_result",
            callId: msg.callId,
            result: { results: ["result1", "result2"] },
          }),
        );
      }
    });

    const result = await mcpClient.callTool({ name: "search", arguments: { q: "test" } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ results: ["result1", "result2"] });

    ext.close();
  });

  test("returns error from extension", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ExecuteToolMessage;
      if (msg.type === "execute_tool") {
        ext.send(
          JSON.stringify({
            type: "tool_result",
            callId: msg.callId,
            error: "Element not found",
            isError: true,
          }),
        );
      }
    });

    const result = await mcpClient.callTool({ name: "click", arguments: { selector: "#x" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("Element not found");

    ext.close();
  });

  test(
    "returns error when no extension connected",
    async () => {
      await createTestStack();

      // No extension connected, call a non-builtin tool — should error after waiting
      const result = await mcpClient.callTool({ name: "missing_tool", arguments: {} });
      expect(result.isError).toBe(true);
    },
    { timeout: 10_000 },
  );
});
