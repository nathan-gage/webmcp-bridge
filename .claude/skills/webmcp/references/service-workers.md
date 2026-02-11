# WebMCP for Service Workers

## Table of Contents

- [Overview](#overview)
- [When to Use Service Workers](#when-to-use-service-workers)
- [Tool Registration in Service Workers](#tool-registration-in-service-workers)
- [Session Management](#session-management)
- [Discovery and Installation](#discovery-and-installation)
- [Routing: Pages vs Service Workers](#routing-pages-vs-service-workers)
- [Opening UI from a Service Worker](#opening-ui-from-a-service-worker)

## Overview

Service workers extend WebMCP to handle tool calls in the background without needing an open tab.
The service worker global scope has a `self.agent` object with the same registration API. Tool
calls are handled entirely in the worker script, but can open browser windows via `postMessage`
when user interaction is needed (e.g., payment, confirmation).

## When to Use Service Workers

- Agent needs tools from a site the user doesn't have open
- Background operations (adding to-do items, syncing data) that don't require UI
- Complex workflows where most steps are automated but some need user handoff (e.g., checkout)

## Tool Registration in Service Workers

```js
// In service worker script
self.agent.provideContext({
  tools: [
    {
      name: "add-to-cart",
      description: "Add an item to the user's shopping cart.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "Product ID" },
          quantity: { type: "number", description: "Number of items" }
        },
        required: ["itemId"]
      },
      async execute(params, clientInfo) {
        const cart = carts.get(clientInfo.sessionId);
        cart.add(params.itemId, params.quantity || 1);
        return { content: [{ type: "text", text: "Item added to cart." }] };
      }
    }
  ]
});
```

Tools are scoped to the service worker's origin and scope path. Tool names like "search" or
"add-to-cart" won't conflict across different origins.

## Session Management

Service workers handle tool calls from multiple agent conversations concurrently. Each tool
call carries a session ID via `clientInfo.sessionId` so the worker can maintain per-session state:

```js
const carts = new Map();

async execute(params, clientInfo) {
  if (!carts.has(clientInfo.sessionId)) {
    carts.set(clientInfo.sessionId, new ShoppingCart());
  }
  const cart = carts.get(clientInfo.sessionId);
  // ... operate on session-specific cart
}
```

## Discovery and Installation

Service workers must be installed before their tools are available. Installation typically
happens when a user first navigates to the site. Future mechanisms include:

**JIT installation via manifest** (proposed):
```json
{
  "name": "Example App",
  "serviceworker": {
    "src": "service-worker.js",
    "scope": "/",
    "use_cache": false
  }
}
```

A new manifest field could advertise WebMCP support so discovery layers (search engines,
directories) can recommend apps to agents. The agent fetches the manifest, installs the
service worker, and begins handling tool requests - all without the user navigating to the page.

**Full flow**: User prompt -> Agent queries discovery layer -> Gets site recommendation ->
Browser fetches manifest + installs service worker -> Worker activates and registers tools ->
Agent can now call tools.

## Routing: Pages vs Service Workers

When both a page and its service worker register tools, routing depends on the agent:

| Scenario | Routing |
|---|---|
| Single tab with tools | All tool calls go to the page |
| Service worker only | All tool calls go to the service worker |
| Tab + service worker | Agent decides (may ask user, use context, or prefer the open tab) |

A single tool call never routes to more than one server, even if multiple servers have tools
with the same name.

## Opening UI from a Service Worker

When a service worker tool needs user interaction (e.g., payment), it opens a browser window
and communicates via `postMessage`:

1. Service worker calls `clients.openWindow("https://example.com/checkout")`
2. Checkout page loads, pre-populates cart data
3. User completes sensitive steps (payment entry)
4. Page signals completion back to service worker via `postMessage`
5. Service worker resolves the tool's execute function

## Security Note

Granting service worker tool access combines private data + untrusted content + external
communication (the "Lethal Trifecta"). A starting mitigation: limit an agent session to a
single origin/scope once it accesses service worker tools, and disable web search and
external communication for that session.
