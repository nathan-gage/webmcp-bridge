---
name: webmcp
description: >
  Implement and understand the WebMCP API - a JavaScript interface that lets web pages expose
  functionality as tools callable by AI agents, browser assistants, and assistive technologies.
  Use when: (1) Adding WebMCP tool registration to a web page (imperative or declarative),
  (2) Implementing execute callbacks for agent tool calls, (3) Understanding the WebMCP lifecycle
  (registration, discovery, invocation, response), (4) Working with navigator.modelContext API
  (provideContext, registerTool, unregisterTool, clearContext), (5) Implementing
  agent.requestUserInteraction for human-in-the-loop flows, (6) Using the declarative API with
  HTML form annotations (toolname, tooldescription, toolautosubmit), (7) Adding service worker
  WebMCP support, (8) Reviewing WebMCP security considerations, (9) Converting existing page JS
  or HTML forms into WebMCP tools, (10) Setting up Chrome 146+ for WebMCP testing.
---

# WebMCP Implementation Guide

WebMCP enables web pages to act as client-side MCP servers by exposing JavaScript functions as tools
that AI agents can invoke. Tools are registered via `navigator.modelContext`, mediated by the browser,
and executed in page script.

## Core Concepts

- **Model context provider**: A top-level browsing context (browser tab) that uses the WebMCP API
- **Agent**: An application (browser AI assistant, extension, native app) that consumes the tools
- **Tool**: A JS function with a name, natural language description, JSON Schema input, and execute callback
- **Browser mediation**: The browser arbitrates tool access, enforces permissions, and maintains backward compatibility

## Implementation Lifecycle

### 1. Feature Detection

```js
if ("modelContext" in window.navigator) {
  // WebMCP supported - register tools
}
```

### 2. Register Tools

Three registration methods:

```js
// Replace all tools at once (useful for SPAs that change state)
navigator.modelContext.provideContext({
  tools: [{ name, description, inputSchema, execute }],
});

// Add a single tool without clearing existing ones
navigator.modelContext.registerTool({ name, description, inputSchema, execute });

// Remove a specific tool
navigator.modelContext.unregisterTool("tool-name");
```

`provideContext` clears pre-existing tools on each call. Use it when the available tool set
changes based on UI state. Use `registerTool`/`unregisterTool` for incremental updates.

### 3. Define Tool Schema

Each tool requires:

```js
{
  name: "add-stamp",                    // Unique identifier
  description: "Add a new stamp to the collection",  // Natural language for the agent
  inputSchema: {                        // JSON Schema
    type: "object",
    properties: {
      name: { type: "string", description: "The name of the stamp" },
      year: { type: "number", description: "The year issued" }
    },
    required: ["name", "year"]
  },
  execute({ name, year }, agent) {      // Callback - receives destructured params + agent
    // Implementation here
  }
}
```

Write clear, accurate descriptions. The agent relies on them to decide when and how to call the tool.
Descriptions that misrepresent behavior are a security concern (see [security.md](references/security.md)).

### 4. Implement Execute Callback

The execute function receives `(params, agent)` and returns a structured content response:

```js
execute({ name, description, year, imageUrl }, agent) {
  addStamp(name, description, year, imageUrl);
  return {
    content: [
      { type: "text", text: `Stamp "${name}" added. Collection has ${stamps.length} stamps.` }
    ]
  };
}
```

Key rules:

- Tool calls run one at a time, sequentially, on the main thread
- The function can be async and return a Promise
- Delegate expensive work to dedicated/shared workers to keep UI responsive
- Always update the UI to reflect state changes from tool calls
- Return structured `{ content: [{ type: "text", text }] }` responses

### 5. Request User Interaction (Human-in-the-Loop)

Use `agent.requestUserInteraction()` when a tool needs user input during execution:

```js
async function buyProduct({ product_id }, agent) {
  const confirmed = await agent.requestUserInteraction(async () => {
    return new Promise((resolve) => {
      resolve(confirm(`Buy product ${product_id}?`));
    });
  });

  if (!confirmed) throw new Error("Purchase cancelled by user.");
  executePurchase(product_id);
  return { content: [{ type: "text", text: `Product ${product_id} purchased.` }] };
}
```

`requestUserInteraction` can be called multiple times within a single tool execution.

## Code Reuse Pattern

Convert existing page logic into WebMCP tools by wrapping existing functions:

```js
// Existing form handler
function addStamp(name, desc, year, imageUrl) {
  stamps.push({ name, description: desc, year, imageUrl: imageUrl || null });
  renderStamps();
}

// WebMCP tool wrapping the same function
execute({ name, description, year, imageUrl }, agent) {
  addStamp(name, description, year, imageUrl);
  return { content: [{ type: "text", text: `Stamp "${name}" added.` }] };
}
```

## Dynamic Tool Sets (SPAs)

Single-page apps should update tools when UI state changes:

```js
function onNavigateToEditor(document) {
  navigator.modelContext.provideContext({
    tools: [
      { name: "edit-design", description: "Modify the current design" /* ... */ },
      { name: "add-page", description: "Add a page to the document" /* ... */ },
    ],
  });
}

function onNavigateToTemplates() {
  navigator.modelContext.provideContext({
    tools: [{ name: "filter-templates", description: "Filter templates by description" /* ... */ }],
  });
}
```

## Declarative API (HTML Form Annotations)

Forms can be automatically exposed as tools using HTML attributes (no JS required):

```html
<form toolname="search_flights" tooldescription="Search for available flights" action="/search">
  <label for="origin">Origin airport code</label>
  <input type="text" name="origin" />

  <label for="destination">Destination airport code</label>
  <input type="text" name="destination" />

  <button type="submit">Search</button>
</form>
```

Key attributes: `toolname`, `tooldescription`, `toolautosubmit`, `toolparamtitle`, `toolparamdescription`.

Detect agent-triggered submissions with `SubmitEvent.agentInvoked` and return results via
`SubmitEvent.respondWith(Promise)`. See [chrome-preview.md](references/chrome-preview.md) for full details.

## Additional Imperative Methods

```js
// Remove all tools at once
navigator.modelContext.clearContext();
```

## WebIDL (Current Spec)

```webidl
partial interface Navigator {
  [SecureContext, SameObject] readonly attribute ModelContextContainer modelContext;
};

[Exposed=Window, SecureContext]
interface ModelContextContainer {
  // provideContext(options)
  // registerTool(toolDef)
  // unregisterTool(name)
};
```

Requires a secure context (HTTPS). Only available on `window.navigator` (top-level browsing context).

## References

- **Chrome preview**: See [chrome-preview.md](references/chrome-preview.md) for the declarative API, `clearContext()`, tool annotations, CSS pseudo-classes, agent events, best practices, and Chrome setup
- **Service workers**: See [service-workers.md](references/service-workers.md) for background tool handling, session management, and discovery
- **Security**: See [security.md](references/security.md) for prompt injection, intent misrepresentation, and over-parameterization risks
- **Spec source**: The normative spec is at `index.bs` (Bikeshed format), built via `make`
- **Full proposal**: `docs/proposal.md` contains the detailed API proposal with alternatives considered
- **Explainer**: `README.md` has use cases (creative design, shopping, code review) and motivation
