/**
 * E2E tests for tool list stability during page navigation and reconnection.
 *
 * Uses InMemoryTransport to wire a real MCP Client <-> Server pair in-process,
 * paired with a real WsServer and mock extension WebSocket client.
 * This tests the full notification flow without needing Chrome.
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
  wsServer = await createWsServer({ port: 0, token: "reconnect-test" });
  mcpServer = createMcpServer(wsServer);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  mcpClient = new Client({ name: "test-client", version: "1.0.0" });

  // Start server-side first, then connect client
  await mcpServer.start(serverTransport);
  await mcpClient.connect(clientTransport);

  return { wsServer, mcpServer, mcpClient };
}

/** Wait for a specific duration */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Debounce time in mcp-server.ts (200ms) plus margin */
const DEBOUNCE_WAIT = 350;

describe("navigation: tool list stability through page navigation", () => {
  test("tools recover after navigation clear → re-register cycle", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    // 1. Extension registers initial tools
    registerTools(ext, [
      { name: "searchFlights", description: "Search flights", inputSchema: { type: "object" } },
    ]);
    await delay(DEBOUNCE_WAIT);

    let result = await mcpClient.listTools();
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("searchFlights");

    // 2. Simulate navigation: rapid empty → new tools (like chrome.tabs.onUpdated "loading")
    registerTools(ext, []); // page unloading clears tools
    registerTools(ext, [
      { name: "viewResults", description: "View search results", inputSchema: { type: "object" } },
    ]);

    // 3. Wait for debounce to settle
    await delay(DEBOUNCE_WAIT);

    // 4. Client should see the new tools (not the empty state)
    result = await mcpClient.listTools();
    const newToolNames = result.tools.map((t) => t.name);
    expect(newToolNames).toContain("viewResults");
    expect(newToolNames).not.toContain("searchFlights");

    ext.close();
  });

  test("multiple rapid navigations settle to final tool set", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    // Simulate 3 rapid navigations
    registerTools(ext, [
      { name: "page1_tool", description: "Page 1", inputSchema: { type: "object" } },
    ]);
    registerTools(ext, []); // nav 1 clear
    registerTools(ext, [
      { name: "page2_tool", description: "Page 2", inputSchema: { type: "object" } },
    ]);
    registerTools(ext, []); // nav 2 clear
    registerTools(ext, [
      { name: "page3_tool", description: "Page 3", inputSchema: { type: "object" } },
    ]);

    await delay(DEBOUNCE_WAIT);

    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("page3_tool");
    expect(names).not.toContain("page1_tool");
    expect(names).not.toContain("page2_tool");

    ext.close();
  });

  test("tools_changed hint triggers MCP list_changed notification", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    let notificationCount = 0;
    mcpClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notificationCount++;
    });

    // Extension sends register_tools (which triggers toolsChanged callback)
    registerTools(ext, [
      { name: "test_tool", description: "Test", inputSchema: { type: "object" } },
    ]);
    await delay(DEBOUNCE_WAIT);

    expect(notificationCount).toBeGreaterThanOrEqual(1);

    ext.close();
  });
});

describe("reconnection: extension disconnect and reconnect", () => {
  test("tools preserved during disconnect, updated on reconnect", async () => {
    await createTestStack();

    // 1. First extension connects with tools
    const ext1 = await connectExtension(wsServer);
    registerTools(ext1, [
      { name: "old_tool", description: "Old", inputSchema: { type: "object" } },
    ]);
    await delay(DEBOUNCE_WAIT);

    let result = await mcpClient.listTools();
    expect(result.tools.map((t) => t.name)).toContain("old_tool");

    // 2. Extension disconnects — tools preserved (stale cache)
    ext1.close();
    await delay(DEBOUNCE_WAIT);

    result = await mcpClient.listTools();
    const afterDisconnect = result.tools.map((t) => t.name);
    expect(afterDisconnect).toContain("webmcp-status");
    expect(afterDisconnect).toContain("old_tool"); // preserved!

    // 3. New extension connects with different tools — cache refreshed
    const ext2 = await connectExtension(wsServer);
    registerTools(ext2, [
      { name: "new_tool", description: "New", inputSchema: { type: "object" } },
    ]);
    await delay(DEBOUNCE_WAIT);

    // 4. Client should see the new tools (old replaced by new)
    result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("new_tool");
    expect(names).not.toContain("old_tool");

    ext2.close();
  });
});

describe("tool call during navigation", () => {
  test("in-flight tool call completes, then new tools are available", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    // 1. Register tools
    registerTools(ext, [
      { name: "searchFlights", description: "Search", inputSchema: { type: "object" } },
    ]);
    await delay(DEBOUNCE_WAIT);

    // 2. Set up extension to handle tool calls
    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ExecuteToolMessage;
      if (msg.type === "execute_tool" && msg.name === "searchFlights") {
        // Respond, then simulate navigation (clear + re-register with new tools)
        ext.send(
          JSON.stringify({
            type: "tool_result",
            callId: msg.callId,
            result: { flights: ["AA100", "UA200"] },
          }),
        );
        // After result, the page navigates — clear then re-register
        registerTools(ext, []);
        registerTools(ext, [
          { name: "viewResults", description: "View results", inputSchema: { type: "object" } },
        ]);
      }
    });

    // 3. Call the tool
    const callResult = await mcpClient.callTool({ name: "searchFlights", arguments: {} });
    expect(callResult.content).toBeDefined();
    const text = (callResult.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ flights: ["AA100", "UA200"] });

    // 4. Wait for debounce, then check new tools are available
    await delay(DEBOUNCE_WAIT);
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("viewResults");
    expect(names).not.toContain("searchFlights");

    ext.close();
  });
});

describe("rapid tool changes", () => {
  test("final tool list is consistent after burst of register_tools", async () => {
    await createTestStack();
    const ext = await connectExtension(wsServer);

    // Send 10 rapid register_tools messages
    for (let i = 0; i < 10; i++) {
      registerTools(ext, [
        { name: `tool_v${i}`, description: `Version ${i}`, inputSchema: { type: "object" } },
      ]);
    }

    await delay(DEBOUNCE_WAIT);

    // Client should see only the final version
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("tool_v9");
    // Should not contain intermediate versions
    expect(names).not.toContain("tool_v0");
    expect(names).not.toContain("tool_v5");

    ext.close();
  });
});

describe("tool call waits for reconnection", () => {
  test("tool call succeeds after brief disconnect + reconnect", async () => {
    await createTestStack();

    // 1. Extension connects
    const ext1 = await connectExtension(wsServer);
    registerTools(ext1, [
      { name: "my_tool", description: "Test", inputSchema: { type: "object" } },
    ]);
    await delay(100);

    // Verify connected
    let tools = await mcpClient.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("my_tool");

    // 2. Disconnect extension
    ext1.close();
    await delay(50);

    // 3. Start a tool call — it will wait for reconnection
    const callPromise = wsServer.executeTool("my_tool", { key: "value" }).catch((e: unknown) => e);

    // 4. Reconnect after 500ms
    await delay(500);
    const ext2 = await connectExtension(wsServer);
    ext2.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === "execute_tool") {
        ext2.send(
          JSON.stringify({
            type: "tool_result",
            callId: msg.callId,
            result: "reconnected result",
          }),
        );
      }
    });

    const result = await callPromise;
    // Should have succeeded after reconnect
    expect((result as { result: string }).result).toBe("reconnected result");

    ext2.close();
  });
});
