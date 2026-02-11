#!/usr/bin/env node
/**
 * WebMCP Bridge entry point.
 * Starts the WebSocket server, writes discovery files, and runs the MCP stdio server.
 */

import { createWsServer } from "./ws-server.js";
import { createMcpServer } from "./mcp-server.js";
import { writePortFile, cleanupPortFile } from "./port-file.js";

async function main() {
  // Start WebSocket server
  const wsServer = await createWsServer();

  // Write discovery files
  await writePortFile(wsServer.port, wsServer.token);

  // Log to stderr (stdout is reserved for MCP stdio)
  process.stderr.write(
    `webmcp-bridge listening on 127.0.0.1:${wsServer.port}\n`
  );

  // Start MCP server on stdio
  const mcpServer = createMcpServer(wsServer);
  await mcpServer.start();

  // Cleanup handler
  let cleanedUp = false;
  async function shutdown() {
    if (cleanedUp) return;
    cleanedUp = true;

    process.stderr.write("webmcp-bridge shutting down...\n");

    await mcpServer.close().catch(() => {});
    await wsServer.close().catch(() => {});
    await cleanupPortFile().catch(() => {});
  }

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });

  process.on("exit", () => {
    // Synchronous cleanup - best effort
    if (!cleanedUp) {
      cleanedUp = true;
    }
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
