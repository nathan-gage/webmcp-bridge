---
name: webmcp-marketplace-plugins
description: "Create WebMCP marketplace plugins (bridge scripts) that add MCP tools to any website. Use when: (1) Creating a new marketplace plugin for a specific website, (2) Writing a webmcp-bridge.json manifest, (3) Writing bridge scripts that call navigator.modelContext.registerTool(), (4) Choosing URL match patterns for script injection, (5) Understanding plugin validation rules and constraints, (6) Testing plugins via local folder install, (7) Publishing plugins to GitHub for installation via user/repo@ref."
---

# WebMCP Marketplace Plugins

A marketplace plugin is a GitHub repo (or local folder) containing a `webmcp-bridge.json` manifest and JavaScript bridge scripts. Scripts are IIFEs that call `navigator.modelContext.registerTool()` to add MCP tools to websites.

## Quick Start

Minimal plugin structure:

```
my-plugin/
├── webmcp-bridge.json
└── scripts/
    └── main.js
```

**webmcp-bridge.json:**

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "your-name",
  "license": "MIT",
  "scripts": [
    {
      "id": "main",
      "name": "Main Script",
      "description": "Brief description",
      "file": "scripts/main.js",
      "matches": ["*://example.com/*"],
      "runAt": "document_idle"
    }
  ]
}
```

**scripts/main.js:**

```js
(function () {
  "use strict";
  if (!navigator.modelContext) return;

  navigator.modelContext.registerTool({
    name: "my_tool",
    description: "What this tool does",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Parameter description" },
      },
    },
    execute: async (args) => {
      // DOM access, fetch, localStorage — all standard browser APIs available
      return { result: "Tool output" };
    },
  });
})();
```

## Manifest Reference

### Top-level fields

| Field         | Required | Type   | Description                       |
| ------------- | -------- | ------ | --------------------------------- |
| `name`        | Yes      | string | Package identifier (non-empty)    |
| `version`     | Yes      | string | Semver (e.g. `"1.0.0"`)           |
| `description` | No       | string | Shown in plugin management UI     |
| `author`      | No       | string | Author name                       |
| `license`     | No       | string | SPDX identifier                   |
| `scripts`     | Yes      | array  | Non-empty array of script entries |

### Script entry fields

| Field         | Required | Type     | Description                                       |
| ------------- | -------- | -------- | ------------------------------------------------- |
| `id`          | Yes      | string   | Unique within the package                         |
| `name`        | No       | string   | Human-readable label for UI                       |
| `description` | No       | string   | Brief description                                 |
| `file`        | Yes      | string   | Path relative to manifest                         |
| `matches`     | Yes      | string[] | URL match patterns (non-empty)                    |
| `runAt`       | No       | string   | `"document_idle"` (default) or `"document_start"` |

## Match Patterns

Chrome extension match pattern syntax: `scheme://host/path`

| Pattern                     | Matches               |
| --------------------------- | --------------------- |
| `<all_urls>`                | All HTTP/HTTPS URLs   |
| `*://mail.google.com/*`     | Gmail (HTTP or HTTPS) |
| `https://github.com/*`      | GitHub HTTPS only     |
| `*://*.google.com/*`        | All Google subdomains |
| `https://example.com/app/*` | Specific path prefix  |

- **Scheme**: `http`, `https`, or `*` (both)
- **Host**: exact (`example.com`), wildcard subdomains (`*.example.com`), or `*` (any)
- **Path**: `/*` (any), or a specific prefix

## Script Authoring

### Requirements

1. Wrap in an IIFE: `(function () { "use strict"; ... })();`
2. Guard with `if (!navigator.modelContext) return;`
3. Use `inputSchema` (not `schema`) in the tool descriptor
4. The `execute` callback receives a plain args object, return the result

### WebMCP API

```js
navigator.modelContext.registerTool(descriptor); // Register one tool
navigator.modelContext.unregisterTool(name); // Remove by name
navigator.modelContext.provideContext({ tools: [] }); // Batch register (array)
navigator.modelContext.clearContext(); // Remove all tools
```

### Execution context

- Scripts run in the **MAIN world** (full page JS/DOM access)
- Injected via `chrome.scripting.executeScript({ world: 'MAIN' })`
- The extension's `content-main.js` wraps `ModelContext.prototype.registerTool` at `document_start`, intercepting all registrations automatically
- Scripts re-inject on navigation; no cleanup needed

### `runAt` timing

- **`document_idle`** (default): Injected after page load complete. Use for most plugins.
- **`document_start`**: Injected during loading. Use only if intercepting early page behavior.

### Common patterns

**DOM scraping tool:**

```js
execute: async () => {
  const items = [...document.querySelectorAll(".item")];
  return { items: items.map((el) => ({ text: el.textContent, href: el.href })) };
};
```

**Form interaction tool:**

```js
execute: async (args) => {
  document.querySelector("#search-input").value = args.query;
  document.querySelector("#search-form").submit();
  return { status: "submitted" };
};
```

**Multiple tools in one script:**

```js
(function () {
  "use strict";
  if (!navigator.modelContext) return;

  navigator.modelContext.registerTool({ name: "tool_a" /* ... */ });
  navigator.modelContext.registerTool({ name: "tool_b" /* ... */ });
})();
```

## Validation

Scripts are scanned for dangerous patterns on install. See [references/validation-rules.md](references/validation-rules.md) for the complete list of blocked patterns and obfuscation thresholds.

Key constraints:

- No `eval()`, `new Function()`, `document.write()`
- No dynamic `<script>` creation
- No WebSocket connections to non-localhost hosts
- No `setAttribute("on...")` for inline event handlers
- Obfuscated code (heavy hex/unicode escapes, minified lines) triggers warnings
- Syntax errors are NOT caught at install time (extension CSP blocks `new Function`); they surface at injection time

## Testing

### Local folder install

1. Create folder with `webmcp-bridge.json` + scripts
2. Open extension popup > **Manage Plugins**
3. Click **Load Folder**, select the folder
4. Navigate to a URL matching your patterns
5. Tools appear in the extension badge and your MCP client

### Dev browser

```bash
bun run chrome       # Launch Chrome with extension pinned
bun run chrome:dev   # Chrome + CLI together
```

### GitHub install

Push to GitHub, then install via `user/repo@ref` in the plugins page:

```
user/repo@v1.0.0     # tag (recommended)
user/repo@main        # branch
user/repo             # latest release or default branch
```

## Working Example

See `examples/marketplace/` in the webmcp-bridge repo for a complete working plugin that registers a `hello_world` tool on all URLs.
