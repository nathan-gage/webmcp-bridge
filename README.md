# WebMCP Bridge

Use tools from any website in any MCP client.

Bridges `navigator.modelContext` (Chrome 146+) to MCP over stdio. A CLI speaks MCP to your client; a Chrome extension intercepts WebMCP tool registrations and forwards them over a localhost WebSocket.

```
MCP Client ──stdio──▶ CLI ──ws──▶ Extension ──▶ navigator.modelContext ──▶ Website
```

## Quick Start

```bash
npm install -g webmcp-bridge
```

Load the extension: `chrome://extensions` → Developer mode → Load unpacked → `extension/`

Add to your MCP client:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "webmcp-bridge"
    }
  }
}
```

Open a [WebMCP-enabled site](https://googlechromelabs.github.io/webmcp-tools/demos/react-flightsearch/). Extension badge goes green. Tools appear in your client.

## Development

```bash
bun install       # deps
bun test          # unit tests
bun run test:e2e  # end-to-end
bun run dev       # dev mode
bun run build     # build for npm
bun run lint      # typecheck
```

## Security

Localhost-only (`127.0.0.1`), random port (13100-13199), 256-bit shared secret, origin-validated, nonce-protected, 0700/0600 file perms. Details in `CLAUDE.md`.

## License

MIT
