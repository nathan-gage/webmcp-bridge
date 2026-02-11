# WebMCP Bridge

Bridges Chrome's `navigator.modelContext` (WebMCP spec, Chrome 146+) to the MCP protocol over stdio, so any MCP client can use tools from any WebMCP-enabled website.

## Architecture

```
MCP Client ──stdio──▶ CLI (ws-server + mcp-server) ──ws://127.0.0.1:{port}──▶ Extension ──▶ navigator.modelContext ──▶ Website
```

Two components: a **CLI bridge** (TypeScript, runs as MCP server) and a **Chrome extension** (MV3, plain JS).

## Commands

```bash
bun install                  # Install dependencies
bun test                     # Run unit tests (62 tests across 5 files)
bun run test:e2e             # E2E: spawns CLI, waits for extension, calls a tool
bun run dev                  # Start CLI in dev mode
bun run build                # Build CLI for npm distribution
bun run lint                 # TypeScript typecheck
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

| File                                  | Count | Tests                                                                         |
| ------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| `test/cli/security.test.ts`           | 15    | Token gen, file perms, origin validation                                      |
| `test/cli/ws-server.test.ts`          | 19    | Connection auth, bootstrap endpoint, tool registration, execution, disconnect |
| `test/cli/mcp-server.test.ts`         | 7     | Tool sync, execution forwarding, status tool                                  |
| `test/cli/integration.test.ts`        | 7     | Full stdio→WS→mock-extension flow                                             |
| `test/extension/content-main.test.ts` | 14    | modelContext interception, nonce validation, tool execution                   |

## Development Tips

- **After changing extension files**: Reload at `chrome://extensions`, then reload the page (content scripts only inject on page load)
- **Extension context invalidated**: Happens when you reload the extension but not the page — always reload both
- **Reconnect backoff**: Extension uses exponential backoff (1s→2s→4s→...→30s) to find the CLI. After restarting the CLI, the extension may take up to 30s to reconnect
- **stdout is MCP**: The CLI reserves stdout for MCP stdio transport. All logging goes to stderr
- **Other WebMCP extensions**: Google's built-in WebMCP extension (`gbpdfapgefenggkahomfgkhfehlcenpd`) may also be present. It uses Chrome's native observation API and doesn't conflict with our prototype wrapping
