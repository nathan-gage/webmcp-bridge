import { describe, test, expect, afterEach } from "bun:test";
import { WebSocket } from "ws";
import { createWsServer, type WsServer } from "../../cli/src/ws-server.js";
import type {
  RegisterToolsMessage,
  ExecuteToolMessage,
  ToolResultMessage,
} from "../../cli/src/protocol.js";

let server: WsServer;

afterEach(async () => {
  if (server) await server.close();
});

function connectExtension(srv: WsServer): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?token=${srv.token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("full flow: extension registration → tool call → result", () => {
  test("complete tool execution cycle", async () => {
    server = await createWsServer({ port: 0, token: "integration-token" });

    // 1. Extension connects
    const ext = await connectExtension(server);
    expect(server.isExtensionConnected()).toBe(true);

    // 2. Extension registers tools
    const registerMsg: RegisterToolsMessage = {
      type: "register_tools",
      tools: [
        {
          name: "get_page_title",
          description: "Get the title of the current page",
          inputSchema: {
            type: "object",
            properties: {
              tabId: { type: "number", description: "Tab ID" },
            },
            required: ["tabId"],
          },
        },
        {
          name: "click_element",
          description: "Click a DOM element",
          inputSchema: {
            type: "object",
            properties: {
              selector: { type: "string" },
            },
            required: ["selector"],
          },
        },
      ],
    };
    ext.send(JSON.stringify(registerMsg));
    await new Promise((r) => setTimeout(r, 50));

    expect(server.getTools()).toHaveLength(2);
    expect(server.getTools().map((t) => t.name)).toEqual(["get_page_title", "click_element"]);

    // 3. Extension handles tool calls
    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ExecuteToolMessage;
      if (msg.type === "execute_tool" && msg.name === "get_page_title") {
        const result: ToolResultMessage = {
          type: "tool_result",
          callId: msg.callId,
          result: "My Page Title",
        };
        ext.send(JSON.stringify(result));
      }
    });

    // 4. CLI executes tool and gets result
    const result = await server.executeTool("get_page_title", { tabId: 1 });
    expect(result.result).toBe("My Page Title");
    expect(result.isError).toBeUndefined();

    ext.close();
  });

  test("tool re-registration replaces tools", async () => {
    server = await createWsServer({ port: 0, token: "re-reg-token" });
    const ext = await connectExtension(server);

    // Register initial tools
    ext.send(
      JSON.stringify({
        type: "register_tools",
        tools: [{ name: "tool_a", description: "A", inputSchema: {} }],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getTools().map((t) => t.name)).toEqual(["tool_a"]);

    // Re-register with different tools
    ext.send(
      JSON.stringify({
        type: "register_tools",
        tools: [
          { name: "tool_b", description: "B", inputSchema: {} },
          { name: "tool_c", description: "C", inputSchema: {} },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getTools().map((t) => t.name)).toEqual(["tool_b", "tool_c"]);

    ext.close();
  });

  test("multiple rapid tool calls", async () => {
    server = await createWsServer({ port: 0, token: "multi-token" });
    const ext = await connectExtension(server);

    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ExecuteToolMessage;
      if (msg.type === "execute_tool") {
        // Echo back the tool name as result
        ext.send(
          JSON.stringify({
            type: "tool_result",
            callId: msg.callId,
            result: `result_${msg.name}`,
          }),
        );
      }
    });

    // Fire multiple calls concurrently
    const [r1, r2, r3] = await Promise.all([
      server.executeTool("tool_1", {}),
      server.executeTool("tool_2", {}),
      server.executeTool("tool_3", {}),
    ]);

    expect(r1.result).toBe("result_tool_1");
    expect(r2.result).toBe("result_tool_2");
    expect(r3.result).toBe("result_tool_3");

    ext.close();
  });

  test("error tool result flow", async () => {
    server = await createWsServer({ port: 0, token: "err-token" });
    const ext = await connectExtension(server);

    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ExecuteToolMessage;
      if (msg.type === "execute_tool") {
        ext.send(
          JSON.stringify({
            type: "tool_result",
            callId: msg.callId,
            error: "Element not found: #missing",
            isError: true,
          }),
        );
      }
    });

    const result = await server.executeTool("click_element", {
      selector: "#missing",
    });
    expect(result.isError).toBe(true);
    expect(result.error).toBe("Element not found: #missing");

    ext.close();
  });

  test("bootstrap → connect → execute flow", async () => {
    server = await createWsServer({ port: 0, token: "bootstrap-token" });

    // 1. Extension discovers token via bootstrap endpoint
    const bootstrapRes = await fetch(`http://127.0.0.1:${server.port}/.well-known/webmcp-bridge`, {
      headers: { Origin: "chrome-extension://test-id" },
    });
    expect(bootstrapRes.status).toBe(200);
    const { token } = (await bootstrapRes.json()) as { token: string };
    expect(token).toBe("bootstrap-token");

    // 2. Extension connects with discovered token
    const ext = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${token}`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
    expect(server.isExtensionConnected()).toBe(true);

    // 3. Register and execute a tool
    ext.send(
      JSON.stringify({
        type: "register_tools",
        tools: [
          {
            name: "navigate",
            description: "Navigate to URL",
            inputSchema: { type: "object", properties: { url: { type: "string" } } },
          },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ExecuteToolMessage;
      if (msg.type === "execute_tool") {
        ext.send(
          JSON.stringify({
            type: "tool_result",
            callId: msg.callId,
            result: { navigated: true, url: msg.arguments.url },
          }),
        );
      }
    });

    const result = await server.executeTool("navigate", {
      url: "https://example.com",
    });
    expect(result.result).toEqual({
      navigated: true,
      url: "https://example.com",
    });

    ext.close();
  });

  test("disconnect mid-call rejects pending calls", async () => {
    server = await createWsServer({ port: 0, token: "dc-token" });
    const ext = await connectExtension(server);

    // Start a tool call but don't reply
    const promise = server.executeTool("slow_tool", {});

    // Disconnect the extension
    ext.close();

    await expect(promise).rejects.toThrow("extension disconnected");
    expect(server.isExtensionConnected()).toBe(false);
    expect(server.getTools()).toHaveLength(0);
  });

  test("new extension replaces old one cleanly", async () => {
    server = await createWsServer({ port: 0, token: "replace-token" });

    const ext1 = await connectExtension(server);
    ext1.send(
      JSON.stringify({
        type: "register_tools",
        tools: [{ name: "old", description: "Old tool", inputSchema: {} }],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getTools()[0].name).toBe("old");

    // New extension connects, replacing old one
    const ext2 = await connectExtension(server);
    ext2.send(
      JSON.stringify({
        type: "register_tools",
        tools: [{ name: "new", description: "New tool", inputSchema: {} }],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getTools()[0].name).toBe("new");

    // Old extension should be closed
    await new Promise((r) => setTimeout(r, 50));
    expect(ext1.readyState).toBe(WebSocket.CLOSED);

    ext2.close();
  });
});
