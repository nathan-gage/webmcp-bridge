/**
 * E2E test helpers — separated from fixtures.ts so Playwright's
 * static analysis doesn't treat them as fixture functions.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Poll mcpClient.listTools() until a non-builtin tool appears or timeout */
export async function waitForTools(client: Client, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { tools } = await client.listTools();
    if (tools.some((t) => t.name !== "webmcp-status")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for extension tools after ${timeoutMs}ms`);
}

/** Wait for a specific tool to appear in the MCP tool list */
export async function waitForTool(
  client: Client,
  toolName: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { tools } = await client.listTools();
    if (tools.some((t) => t.name === toolName)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for tool "${toolName}" after ${timeoutMs}ms`);
}
