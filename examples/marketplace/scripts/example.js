(function () {
  "use strict";
  if (!navigator.modelContext) return;

  navigator.modelContext.registerTool({
    name: "hello_world",
    description: "Returns a greeting. Use this to test the WebMCP bridge marketplace.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name to greet",
        },
      },
    },
    execute: async (args) => {
      const name = args.name || "World";
      return { greeting: `Hello, ${name}! This tool was injected via the WebMCP marketplace.` };
    },
  });
})();
