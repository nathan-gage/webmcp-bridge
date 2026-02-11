/**
 * Playwright fixture for WebMCP Bridge E2E tests.
 *
 * Worker-scoped: a single Chrome context + CLI is shared across all tests
 * in a file. This matches real usage (one extension, one CLI, multiple
 * page navigations) and avoids flaky reconnection issues.
 *
 * - Discovers Chrome for Testing Canary binary
 * - Spawns CLI first (so it's listening before Chrome starts)
 * - Launches persistent browser context with our extension loaded
 * - Serves test HTML pages on a local HTTP server
 * - Polls mcpClient.listTools() until extension tools appear
 */

import { test as base, chromium, type BrowserContext } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const EXTENSION_PATH = resolve(ROOT, "extension");
const CLI_ENTRY = resolve(ROOT, "cli/dist/index.js");

/** Discover Chrome for Testing Canary binary from .chrome-for-testing/ */
function findCftBinary(): string {
  const cftDir = resolve(ROOT, ".chrome-for-testing");

  let entries: string[];
  try {
    entries = readdirSync(resolve(cftDir, "chrome"));
  } catch {
    throw new Error("Chrome for Testing not found. Run: npm run test:e2e:install");
  }

  const versionDir = entries.find(
    (e) => e.startsWith("mac_arm-") || e.startsWith("mac-") || e.startsWith("linux64-"),
  );
  if (!versionDir) {
    throw new Error(
      `No Chrome for Testing version directory found in ${cftDir}/chrome/. Entries: ${entries.join(", ")}`,
    );
  }

  const versionPath = resolve(cftDir, "chrome", versionDir);
  const subdirs = readdirSync(versionPath);
  const chromeSubdir = subdirs.find((d) => d.startsWith("chrome-"));
  if (!chromeSubdir) {
    throw new Error(`No chrome-* subdirectory in ${versionPath}. Found: ${subdirs.join(", ")}`);
  }

  if (chromeSubdir.startsWith("chrome-linux")) {
    return resolve(versionPath, chromeSubdir, "chrome");
  }

  return resolve(
    versionPath,
    chromeSubdir,
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  );
}

/** Start a local HTTP server serving files from test/e2e/ */
function startTestServer(): Promise<{ server: Server; port: number }> {
  return new Promise((ok, fail) => {
    const server = createServer((req, res) => {
      const filePath = resolve(__dirname, `.${req.url}`);
      try {
        const content = readFileSync(filePath);
        const ext = filePath.split(".").pop();
        const mime =
          ext === "html" ? "text/html" : ext === "js" ? "application/javascript" : "text/plain";
        res.writeHead(200, { "Content-Type": mime });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        ok({ server, port: addr.port });
      } else {
        fail(new Error("Failed to start test server"));
      }
    });
  });
}

/** Poll mcpClient.listTools() until a non-builtin tool appears or timeout */
async function waitForTools(client: Client, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { tools } = await client.listTools();
    if (tools.some((t) => t.name !== "webmcp-status")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for extension tools after ${timeoutMs}ms`);
}

/** Wait for a specific tool to appear in the MCP tool list */
async function waitForTool(client: Client, toolName: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { tools } = await client.listTools();
    if (tools.some((t) => t.name === toolName)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for tool "${toolName}" after ${timeoutMs}ms`);
}

type WorkerFixtures = {
  mcpClient: Client;
  sharedContext: BrowserContext;
  baseUrl: string;
};

export const test = base.extend<{}, WorkerFixtures>({
  baseUrl: [
    async (_deps: unknown, use: (value: string) => Promise<void>) => {
      const { server, port } = await startTestServer();
      await use(`http://127.0.0.1:${port}`);
      server.close();
    },
    { scope: "worker" },
  ],

  // CLI must start BEFORE Chrome so the extension can find it on first port scan.
  mcpClient: [
    async (_deps: unknown, use: (value: Client) => Promise<void>) => {
      const transport = new StdioClientTransport({
        command: "node",
        args: [CLI_ENTRY],
      });

      const client = new Client({ name: "e2e-test", version: "1.0.0" });
      await client.connect(transport);

      await use(client);
      await client.close();
    },
    { scope: "worker" },
  ],

  // Context depends on mcpClient (via destructuring) to ensure CLI is up first.
  sharedContext: [
    async ({ mcpClient: _mcpClient }, use) => {
      const executablePath = findCftBinary();
      const userDataDir = mkdtempSync(join(tmpdir(), "webmcp-e2e-"));

      // Enable WebMCP flag via Chrome's Local State preferences
      writeFileSync(
        join(userDataDir, "Local State"),
        JSON.stringify({
          browser: {
            enabled_labs_experiments: ["enable-webmcp-testing@1"],
          },
        }),
      );

      const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath,
        headless: false,
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          "--no-first-run",
          "--disable-default-apps",
        ],
      });

      await use(context);
      await context.close();
    },
    { scope: "worker" },
  ],
});

export { waitForTools, waitForTool };
export { expect } from "@playwright/test";
