# WebMCP Bridge

Bridges Chrome's `navigator.modelContext` (WebMCP spec, Chrome 146+) to the MCP protocol over stdio, so any MCP client can use tools from any WebMCP-enabled website.

## Philosophy

This codebase will outlive you. Every shortcut becomes someone else's burden. Every hack compounds into technical debt that slows the whole team down.

You are not just writing code. You are shaping the future of this project. The patterns you establish will be copied. The corners you cut will be cut again.

Fight entropy. Leave the codebase better than you found it.

## Architecture

```
MCP Client ──stdio──▶ CLI (ws-server + mcp-server) ──ws://127.0.0.1:{port}──▶ Extension ──▶ navigator.modelContext ──▶ Website
```

Two components: a **CLI bridge** (TypeScript, runs as MCP server) and a **Chrome extension** (MV3, plain JS).

## Commands

```bash
bun install                  # Install dependencies
bun test                     # Run unit tests
bun run test:e2e:pw          # Playwright E2E (needs Chrome Canary, see below)
bun run dev                  # Start CLI in dev mode
bun run build                # Build CLI for npm distribution
bun run lint                 # Lint (oxlint)
```

## CLI (`cli/src/`)

| File            | Purpose                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`      | Entry point — starts WS server, writes discovery files, starts MCP stdio server, handles shutdown                                           |
| `mcp-server.ts` | MCP server using low-level `Server` class (NOT `McpServer` — see gotcha below). Handles `tools/list` and `tools/call`                       |
| `ws-server.ts`  | HTTP + WebSocket server on `127.0.0.1:{random port in 13100-13199}`. Bootstrap endpoint, token auth, message routing, 30s tool call timeout |
| `protocol.ts`   | Wire protocol types: `register_tools`, `execute_tool`, `tool_result`. Discriminated union + type guards                                     |
| `port-file.ts`  | Reads/writes `~/.webmcp/port` and `~/.webmcp/token` for extension discovery                                                                 |
| `security.ts`   | Token generation, secure file I/O (0700 dirs, 0600 files), origin validation                                                                |

### Key gotcha: MCP SDK and JSON Schema

**Must use `Server` (low-level), not `McpServer` (high-level).** The `McpServer.registerTool()` API runs tool arguments through Zod validation via `safeParseAsync`. WebMCP tools provide plain JSON Schema objects (not Zod schemas), so `McpServer` throws `schema.safeParseAsync is not a function`. The low-level `Server` with `setRequestHandler(ListToolsRequestSchema, ...)` and `setRequestHandler(CallToolRequestSchema, ...)` bypasses Zod entirely.

## Extension (`extension/`)

| File                  | World          | Purpose                                                                                                                           |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `content-main.js`     | MAIN           | Wraps `ModelContext.prototype` methods to intercept tool registrations. Posts `tools-changed` / `tool-result` messages with nonce |
| `content-isolated.js` | ISOLATED       | Generates nonce, relays messages between MAIN world (`window.postMessage`) and background (`chrome.runtime`)                      |
| `background.js`       | Service Worker | WS client to CLI, tab tracking, tool aggregation, port discovery with exponential backoff, badge management                       |
| `popup.html/js/css`   | —              | Status popup showing connection state and active tools                                                                            |
| `manifest.json`       | —              | MV3 manifest. Content scripts run at `document_start` in both MAIN and ISOLATED worlds                                            |

### Key gotcha: Prototype wrapping, not instance wrapping

**Must wrap `ModelContext.prototype.registerTool`, not `navigator.modelContext.registerTool`.** Polling for the instance with `setInterval` loses the race — page JS registers tools before the poll fires. Wrapping the prototype at `document_start` catches all registrations.

### Key gotcha: WebMCP API signature

The native `ModelContext` API uses single-argument descriptors:

- `registerTool(descriptor)` where descriptor is `{name, description, inputSchema, execute}`
- `provideContext({tools: [descriptor, ...]})` — tools is an **array**, not an object
- Field is `inputSchema` (not `schema`)

### Key gotcha: Origin validation

Chrome extension service workers making `fetch()` requests to `host_permissions` URLs may **not** send an `Origin` header. The bootstrap endpoint (`/.well-known/webmcp-bridge`) must accept requests with no origin while still rejecting `http://` and `https://` origins from web pages.

## Wire Protocol (WebSocket)

Extension → CLI:

```json
{"type": "register_tools", "tools": [{"name": "...", "description": "...", "inputSchema": {...}}]}
{"type": "tool_result", "callId": "uuid", "result": ..., "error": "..."}
```

CLI → Extension:

```json
{"type": "execute_tool", "callId": "uuid", "name": "toolName", "arguments": {...}}
```

## Security Model

- **Localhost-only**: WS binds to `127.0.0.1`, random port in 13100–13199
- **Shared secret**: 256-bit token in `~/.webmcp/token` (mode 0600), validated on WS upgrade
- **Origin check**: Bootstrap endpoint rejects `http://` and `https://` origins (web pages)
- **Content script nonce**: `crypto.randomUUID()` nonce prevents page JS from spoofing bridge messages
- **File perms**: `~/.webmcp/` dir is 0700, files are 0600
- **Cleanup**: Port/token files deleted on SIGINT/SIGTERM

## Tests (`test/`)

- **Unit tests** (`bun test`): `test/cli/` and `test/extension/` — run via bun's built-in test runner
- **Playwright E2E** (`bun run test:e2e:pw`): `test/e2e/` — full pipeline through real Chrome with the extension loaded

### Playwright E2E setup

Requires Chrome for Testing Canary (146+) with WebMCP support:

```bash
bun run test:e2e:install     # One-time: download Chrome Canary to .chrome-for-testing/
bun run test:e2e:pw          # Build CLI + run Playwright (headed, sequential)
```

### Key gotcha: Playwright fixture files

Helper functions must be in `test/e2e/helpers.ts`, **not** in `test/e2e/fixtures.ts`. Playwright 1.58+ statically analyzes all functions in fixture files and rejects any whose first parameter isn't a destructured fixture object. Keep non-fixture helpers separate.

## Development Tips

- **After changing extension files**: Reload at `chrome://extensions`, then reload the page (content scripts only inject on page load)
- **Extension context invalidated**: Happens when you reload the extension but not the page — always reload both
- **Reconnect backoff**: Extension uses exponential backoff (1s→2s→4s→...→30s) to find the CLI. After restarting the CLI, the extension may take up to 30s to reconnect
- **stdout is MCP**: The CLI reserves stdout for MCP stdio transport. All logging goes to stderr
- **Other WebMCP extensions**: Google's built-in WebMCP extension (`gbpdfapgefenggkahomfgkhfehlcenpd`) may also be present. It uses Chrome's native observation API and doesn't conflict with our prototype wrapping
