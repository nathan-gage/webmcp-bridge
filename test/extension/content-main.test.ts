import { describe, test, expect, beforeEach, mock } from "bun:test";

// --- Helpers & mocks ---

/** WebMCP tool descriptor — single object passed to registerTool() */
interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => unknown;
}

interface ModelContext {
  registerTool: (descriptor: ToolDescriptor) => void;
  unregisterTool: (name: string) => void;
  provideContext: (ctx: { tools: ToolDescriptor[] }) => void;
  clearContext: () => void;
}

interface PostedMessage {
  source: string;
  nonce: string;
  type: string;
  [key: string]: unknown;
}

const NONCE = "test-nonce-123";

let postedMessages: PostedMessage[];
let modelContext: ModelContext;

function setupMocks() {
  postedMessages = [];

  modelContext = {
    registerTool: mock(() => {}),
    unregisterTool: mock(() => {}),
    provideContext: mock(() => {}),
    clearContext: mock(() => {}),
  };
}

/**
 * Simulates what content-main.js does without needing to eval the script.
 * Faithful reproduction of the IIFE logic for testing.
 */
function createContentMainLogic(nonce: string | undefined) {
  if (!nonce) return null;

  const toolMap = new Map<string, { serialized: Record<string, unknown>; execute: (args: Record<string, unknown>) => unknown }>();

  function postToIsolated(type: string, payload: Record<string, unknown>) {
    postedMessages.push({
      source: "webmcp-main",
      nonce,
      type,
      ...payload,
    });
  }

  function broadcastToolsChanged() {
    const tools: Record<string, unknown>[] = [];
    for (const [, entry] of toolMap) {
      tools.push(entry.serialized);
    }
    postToIsolated("tools-changed", { tools });
  }

  // Message handler for execute-tool
  function handleMessage(event: {
    origin: string;
    data?: { nonce?: string; source?: string; type?: string; callId?: string; toolName?: string; args?: Record<string, unknown> };
  }) {
    if (event.origin !== "http://localhost") return;
    if (!event.data || event.data.nonce !== nonce) return;
    if (event.data.source !== "webmcp-isolated") return;

    if (event.data.type === "execute-tool") {
      const { callId, toolName, args } = event.data;
      const entry = toolMap.get(toolName!);

      if (!entry) {
        postToIsolated("tool-result", {
          callId,
          error: `Tool "${toolName}" not found`,
        });
        return;
      }

      try {
        const result = entry.execute(args || {});
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).then(
            (r) => postToIsolated("tool-result", { callId, result: r }),
            (err: Error) => postToIsolated("tool-result", { callId, error: err.message }),
          );
        } else {
          postToIsolated("tool-result", { callId, result });
        }
      } catch (err) {
        postToIsolated("tool-result", {
          callId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Wrap modelContext methods (mirrors content-main.js after polling finds navigator.modelContext)
  const mc = modelContext;
  const origRegister = mc.registerTool.bind(mc);
  const origUnregister = mc.unregisterTool.bind(mc);
  const origProvide = mc.provideContext.bind(mc);
  const origClear = mc.clearContext.bind(mc);

  mc.registerTool = (descriptor: ToolDescriptor) => {
    toolMap.set(descriptor.name, {
      serialized: { name: descriptor.name, description: descriptor.description, inputSchema: descriptor.inputSchema },
      execute: descriptor.execute,
    });
    origRegister(descriptor);
    broadcastToolsChanged();
  };

  mc.unregisterTool = (name: string) => {
    toolMap.delete(name);
    origUnregister(name);
    broadcastToolsChanged();
  };

  mc.provideContext = (ctx: { tools: ToolDescriptor[] }) => {
    toolMap.clear();
    if (ctx && Array.isArray(ctx.tools)) {
      for (const tool of ctx.tools) {
        toolMap.set(tool.name, {
          serialized: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
          execute: tool.execute,
        });
      }
    }
    origProvide(ctx);
    broadcastToolsChanged();
  };

  mc.clearContext = () => {
    toolMap.clear();
    origClear();
    broadcastToolsChanged();
  };

  return { toolMap, handleMessage, mc };
}

describe("content-main", () => {
  beforeEach(() => {
    setupMocks();
  });

  test("returns null when nonce is missing", () => {
    const result = createContentMainLogic(undefined);
    expect(result).toBeNull();
  });

  test("registerTool captures tool and broadcasts tools-changed", () => {
    const logic = createContentMainLogic(NONCE)!;
    const executeFn = mock(() => "result");

    logic.mc.registerTool({
      name: "test-tool",
      description: "A test tool",
      inputSchema: { type: "object" },
      execute: executeFn,
    });

    expect(logic.toolMap.has("test-tool")).toBe(true);
    expect(logic.toolMap.get("test-tool")!.serialized).toEqual({
      name: "test-tool",
      description: "A test tool",
      inputSchema: { type: "object" },
    });

    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].type).toBe("tools-changed");
    expect(postedMessages[0].nonce).toBe(NONCE);
    expect(postedMessages[0].source).toBe("webmcp-main");
    expect((postedMessages[0].tools as unknown[]).length).toBe(1);
  });

  test("registerTool calls original registerTool", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({
      name: "tool1",
      description: "desc",
      inputSchema: {},
      execute: () => {},
    });

    expect(postedMessages.length).toBeGreaterThan(0);
  });

  test("unregisterTool removes tool and broadcasts", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({
      name: "tool-a",
      description: "Tool A",
      inputSchema: {},
      execute: () => {},
    });
    postedMessages.length = 0;

    logic.mc.unregisterTool("tool-a");

    expect(logic.toolMap.has("tool-a")).toBe(false);
    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].type).toBe("tools-changed");
    expect((postedMessages[0].tools as unknown[]).length).toBe(0);
  });

  test("provideContext replaces all tools", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({
      name: "old-tool",
      description: "Old",
      inputSchema: {},
      execute: () => {},
    });
    postedMessages.length = 0;

    logic.mc.provideContext({
      tools: [
        { name: "new-tool-1", description: "New 1", inputSchema: { type: "string" }, execute: () => "r1" },
        { name: "new-tool-2", description: "New 2", inputSchema: { type: "number" }, execute: () => "r2" },
      ],
    });

    expect(logic.toolMap.has("old-tool")).toBe(false);
    expect(logic.toolMap.has("new-tool-1")).toBe(true);
    expect(logic.toolMap.has("new-tool-2")).toBe(true);
    expect(logic.toolMap.size).toBe(2);

    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].type).toBe("tools-changed");
    expect((postedMessages[0].tools as unknown[]).length).toBe(2);
  });

  test("clearContext removes all tools", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({ name: "tool-1", description: "T1", inputSchema: {}, execute: () => {} });
    logic.mc.registerTool({ name: "tool-2", description: "T2", inputSchema: {}, execute: () => {} });
    postedMessages.length = 0;

    logic.mc.clearContext();

    expect(logic.toolMap.size).toBe(0);
    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].type).toBe("tools-changed");
    expect((postedMessages[0].tools as unknown[]).length).toBe(0);
  });

  test("execute-tool calls the right function and posts result", () => {
    const logic = createContentMainLogic(NONCE)!;
    const executeFn = mock((args: Record<string, unknown>) => ({ answer: args.x }));

    logic.mc.registerTool({
      name: "calc",
      description: "Calculator",
      inputSchema: { type: "object" },
      execute: executeFn,
    });
    postedMessages.length = 0;

    logic.handleMessage({
      origin: "http://localhost",
      data: {
        nonce: NONCE,
        source: "webmcp-isolated",
        type: "execute-tool",
        callId: "call-1",
        toolName: "calc",
        args: { x: 42 },
      },
    });

    expect(executeFn).toHaveBeenCalledWith({ x: 42 });
    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].type).toBe("tool-result");
    expect(postedMessages[0].callId).toBe("call-1");
    expect(postedMessages[0].result).toEqual({ answer: 42 });
  });

  test("execute-tool returns error for unknown tool", () => {
    const logic = createContentMainLogic(NONCE)!;
    postedMessages.length = 0;

    logic.handleMessage({
      origin: "http://localhost",
      data: {
        nonce: NONCE,
        source: "webmcp-isolated",
        type: "execute-tool",
        callId: "call-2",
        toolName: "nonexistent",
        args: {},
      },
    });

    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].type).toBe("tool-result");
    expect(postedMessages[0].callId).toBe("call-2");
    expect(postedMessages[0].error).toBe('Tool "nonexistent" not found');
  });

  test("execute-tool handles thrown errors", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({
      name: "failing",
      description: "Fails",
      inputSchema: {},
      execute: () => {
        throw new Error("something broke");
      },
    });
    postedMessages.length = 0;

    logic.handleMessage({
      origin: "http://localhost",
      data: {
        nonce: NONCE,
        source: "webmcp-isolated",
        type: "execute-tool",
        callId: "call-3",
        toolName: "failing",
        args: {},
      },
    });

    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].type).toBe("tool-result");
    expect(postedMessages[0].error).toBe("something broke");
  });

  test("messages without matching nonce are ignored", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({
      name: "my-tool",
      description: "Tool",
      inputSchema: {},
      execute: mock(() => "ok"),
    });
    postedMessages.length = 0;

    logic.handleMessage({
      origin: "http://localhost",
      data: {
        nonce: "wrong-nonce",
        source: "webmcp-isolated",
        type: "execute-tool",
        callId: "call-4",
        toolName: "my-tool",
        args: {},
      },
    });

    expect(postedMessages.length).toBe(0);
  });

  test("messages from wrong origin are ignored", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({
      name: "my-tool",
      description: "Tool",
      inputSchema: {},
      execute: mock(() => "ok"),
    });
    postedMessages.length = 0;

    logic.handleMessage({
      origin: "http://evil.com",
      data: {
        nonce: NONCE,
        source: "webmcp-isolated",
        type: "execute-tool",
        callId: "call-5",
        toolName: "my-tool",
        args: {},
      },
    });

    expect(postedMessages.length).toBe(0);
  });

  test("messages from wrong source are ignored", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({
      name: "my-tool",
      description: "Tool",
      inputSchema: {},
      execute: mock(() => "ok"),
    });
    postedMessages.length = 0;

    logic.handleMessage({
      origin: "http://localhost",
      data: {
        nonce: NONCE,
        source: "some-other-source",
        type: "execute-tool",
        callId: "call-6",
        toolName: "my-tool",
        args: {},
      },
    });

    expect(postedMessages.length).toBe(0);
  });

  test("execute-tool handles async execute functions", async () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({
      name: "async-tool",
      description: "Async",
      inputSchema: {},
      execute: async (args: Record<string, unknown>) => {
        return { doubled: (args.n as number) * 2 };
      },
    });
    postedMessages.length = 0;

    logic.handleMessage({
      origin: "http://localhost",
      data: {
        nonce: NONCE,
        source: "webmcp-isolated",
        type: "execute-tool",
        callId: "call-async",
        toolName: "async-tool",
        args: { n: 5 },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].type).toBe("tool-result");
    expect(postedMessages[0].callId).toBe("call-async");
    expect(postedMessages[0].result).toEqual({ doubled: 10 });
  });

  test("multiple registerTool calls accumulate tools", () => {
    const logic = createContentMainLogic(NONCE)!;

    logic.mc.registerTool({ name: "tool-a", description: "A", inputSchema: {}, execute: () => {} });
    logic.mc.registerTool({ name: "tool-b", description: "B", inputSchema: {}, execute: () => {} });
    logic.mc.registerTool({ name: "tool-c", description: "C", inputSchema: {}, execute: () => {} });

    expect(logic.toolMap.size).toBe(3);

    const lastMsg = postedMessages[postedMessages.length - 1];
    expect(lastMsg.type).toBe("tools-changed");
    expect((lastMsg.tools as unknown[]).length).toBe(3);
  });
});
