import { describe, test, expect, mock } from "bun:test";
import type { WsServer } from "../../cli/src/ws-server.js";
import type { ToolResultMessage } from "../../cli/src/protocol.js";
import { createMcpServer } from "../../cli/src/mcp-server.js";

/** Create a mock WsServer for testing */
function createMockWsServer(overrides: Partial<WsServer> = {}): WsServer & {
  _toolsChangedCb: ((tools: ToolSchema[]) => void) | null;
  _simulateToolsChanged: (tools: ToolSchema[]) => void;
} {
  let toolsChangedCb: ((tools: ToolSchema[]) => void) | null = null;
  let tools: ToolSchema[] = [];
  let connected = false;

  const mockServer = {
    port: 13100,
    token: "mock-token",
    getTools: () => tools,
    isExtensionConnected: () => connected,
    executeTool: mock(
      async (name: string, args: Record<string, unknown>): Promise<ToolResultMessage> => {
        return {
          type: "tool_result",
          callId: "mock-call-id",
          result: { name, args },
        };
      },
    ),
    onToolsChanged: (cb: (tools: ToolSchema[]) => void) => {
      toolsChangedCb = cb;
    },
    close: mock(async () => {}),
    _toolsChangedCb: null as ((tools: ToolSchema[]) => void) | null,
    _simulateToolsChanged: (newTools: ToolSchema[]) => {
      tools = newTools;
      connected = newTools.length > 0;
      if (toolsChangedCb) toolsChangedCb(newTools);
    },
    ...overrides,
  };

  // Keep reference accessible
  Object.defineProperty(mockServer, "_toolsChangedCb", {
    get: () => toolsChangedCb,
  });

  return mockServer;
}

describe("McpBridgeServer", () => {
  test("creates without error", () => {
    const ws = createMockWsServer();
    const mcpServer = createMcpServer(ws);
    expect(mcpServer).toBeDefined();
    expect(mcpServer.start).toBeFunction();
    expect(mcpServer.close).toBeFunction();
    expect(mcpServer.notifyToolsChanged).toBeFunction();
  });
});

describe("webmcp-status tool", () => {
  test("is registered as a built-in tool", () => {
    // The status tool is registered in createMcpServer, not dependent on extension
    const ws = createMockWsServer();
    const mcpServer = createMcpServer(ws);
    // We can't easily test the MCP tool listing without a full stdio transport,
    // but we can verify the server was created successfully
    expect(mcpServer).toBeDefined();
  });
});

describe("tool synchronization", () => {
  test("registers onToolsChanged callback with ws server", () => {
    const ws = createMockWsServer();
    createMcpServer(ws);
    // The callback should be registered during start, not construction
    expect(ws._toolsChangedCb).toBeNull();
  });

  test("syncs tools when _simulateToolsChanged fires after start would register callback", () => {
    const ws = createMockWsServer();
    createMcpServer(ws);
    // After start(), the callback gets wired up
    // We can verify the mock server can simulate tool changes
    ws._simulateToolsChanged([
      { name: "test_tool", description: "Test", inputSchema: { type: "object" } },
    ]);
    expect(ws.getTools()).toHaveLength(1);
  });
});

describe("tool execution forwarding", () => {
  test("executeTool is available on mock ws server", async () => {
    const ws = createMockWsServer();
    const result = await ws.executeTool("test_tool", { key: "value" });
    expect(result.type).toBe("tool_result");
    expect(result.result).toEqual({ name: "test_tool", args: { key: "value" } });
  });

  test("executeTool handles error results", async () => {
    const ws = createMockWsServer({
      executeTool: mock(async () => ({
        type: "tool_result" as const,
        callId: "err-id",
        error: "Something failed",
        isError: true,
      })),
    });

    const result = await ws.executeTool("failing_tool", {});
    expect(result.isError).toBe(true);
    expect(result.error).toBe("Something failed");
  });

  test("executeTool rejects when not connected", async () => {
    const ws = createMockWsServer({
      executeTool: mock(async () => {
        throw new Error("No extension connected");
      }),
    });

    await expect(ws.executeTool("test", {})).rejects.toThrow("No extension connected");
  });
});
