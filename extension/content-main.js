"use strict";

(() => {
  const NONCE = document.documentElement.dataset.webmcpNonce;
  if (!NONCE) return;

  const toolMap = new Map(); // name → { serialized, execute }

  function postToIsolated(type, payload) {
    window.postMessage({ source: "webmcp-main", nonce: NONCE, type, ...payload }, window.location.origin);
  }

  function broadcastToolsChanged() {
    const tools = [];
    for (const [name, entry] of toolMap) {
      tools.push(entry.serialized);
    }
    postToIsolated("tools-changed", { tools });
  }

  // Listen for execute-tool requests from the isolated world
  window.addEventListener("message", async (event) => {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.nonce !== NONCE) return;
    if (event.data.source !== "webmcp-isolated") return;

    if (event.data.type === "execute-tool") {
      const { callId, toolName, args } = event.data;
      const entry = toolMap.get(toolName);

      if (!entry) {
        postToIsolated("tool-result", {
          callId,
          error: `Tool "${toolName}" not found`,
        });
        return;
      }

      try {
        const result = await entry.execute(args);
        postToIsolated("tool-result", { callId, result });
      } catch (err) {
        postToIsolated("tool-result", {
          callId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // Wrap ModelContext.prototype immediately — no polling needed.
  // This runs at document_start before page JS, so we catch all registrations.
  const MC = typeof ModelContext !== "undefined" ? ModelContext : null;
  if (!MC) return;

  const proto = MC.prototype;
  const origRegister = proto.registerTool;
  const origUnregister = proto.unregisterTool;
  const origProvide = proto.provideContext;
  const origClear = proto.clearContext;

  proto.registerTool = function (descriptor) {
    toolMap.set(descriptor.name, {
      serialized: {
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      },
      execute: descriptor.execute,
    });
    const result = origRegister.call(this, descriptor);
    broadcastToolsChanged();
    return result;
  };

  proto.unregisterTool = function (name) {
    toolMap.delete(name);
    const result = origUnregister.call(this, name);
    broadcastToolsChanged();
    return result;
  };

  proto.provideContext = function (ctx) {
    toolMap.clear();
    if (ctx && Array.isArray(ctx.tools)) {
      for (const tool of ctx.tools) {
        toolMap.set(tool.name, {
          serialized: {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
          execute: tool.execute,
        });
      }
    }
    const result = origProvide.call(this, ctx);
    broadcastToolsChanged();
    return result;
  };

  proto.clearContext = function () {
    toolMap.clear();
    const result = origClear.call(this);
    broadcastToolsChanged();
    return result;
  };
})();
