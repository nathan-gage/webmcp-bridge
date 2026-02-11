/**
 * E2E tests for the full WebMCP Bridge pipeline:
 * Chrome Extension <-> CLI <-> MCP Client
 *
 * Requires Chrome for Testing Canary (run: npm run test:e2e:install)
 * and a built CLI (run: npm run build).
 */

import { test, expect, waitForTools, waitForTool } from "./fixtures.js";

test("extension connects to CLI and page tools appear in MCP tools/list", async ({
  mcpClient,
  sharedContext,
  baseUrl,
}) => {
  const page = await sharedContext.newPage();
  try {
    await page.goto(`${baseUrl}/test-page.html`);
    await page.waitForFunction(() => document.title === "ready" || document.title === "no-webmcp");

    if ((await page.title()) === "no-webmcp") {
      test.skip(true, "navigator.modelContext not available — Chrome Canary 146+ required");
      return;
    }

    await waitForTools(mcpClient);

    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("e2e_echo");
    expect(names).toContain("webmcp-status");
  } finally {
    await page.close();
  }
});

test("webmcp-status shows connected with tools", async ({ mcpClient, sharedContext, baseUrl }) => {
  const page = await sharedContext.newPage();
  try {
    await page.goto(`${baseUrl}/test-page.html`);
    await page.waitForFunction(() => document.title === "ready" || document.title === "no-webmcp");

    if ((await page.title()) === "no-webmcp") {
      test.skip(true, "navigator.modelContext not available");
      return;
    }

    await waitForTools(mcpClient);

    const result = await mcpClient.callTool({ name: "webmcp-status", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const status = JSON.parse(text);

    expect(status.connected).toBe(true);
    expect(status.toolCount).toBeGreaterThanOrEqual(1);
    expect(status.tools).toContain("e2e_echo");
  } finally {
    await page.close();
  }
});

test("tool execution round-trip", async ({ mcpClient, sharedContext, baseUrl }) => {
  const page = await sharedContext.newPage();
  try {
    await page.goto(`${baseUrl}/test-page.html`);
    await page.waitForFunction(() => document.title === "ready" || document.title === "no-webmcp");

    if ((await page.title()) === "no-webmcp") {
      test.skip(true, "navigator.modelContext not available");
      return;
    }

    await waitForTools(mcpClient);

    const result = await mcpClient.callTool({
      name: "e2e_echo",
      arguments: { message: "hello from e2e" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ echo: "hello from e2e" });
  } finally {
    await page.close();
  }
});

test("navigation updates tool list", async ({ mcpClient, sharedContext, baseUrl }) => {
  const page = await sharedContext.newPage();
  try {
    await page.goto(`${baseUrl}/test-page.html`);
    await page.waitForFunction(() => document.title === "ready" || document.title === "no-webmcp");

    if ((await page.title()) === "no-webmcp") {
      test.skip(true, "navigator.modelContext not available");
      return;
    }

    await waitForTools(mcpClient);

    let { tools } = await mcpClient.listTools();
    expect(tools.map((t) => t.name)).toContain("e2e_echo");

    // Navigate to page 2 (e2e_greet)
    await page.goto(`${baseUrl}/test-page-2.html`);
    await page.waitForFunction(() => document.title === "ready");

    await waitForTool(mcpClient, "e2e_greet");

    ({ tools } = await mcpClient.listTools());
    expect(tools.map((t) => t.name)).toContain("e2e_greet");
  } finally {
    await page.close();
  }
});

test("tool call that triggers redirect completes, then new tools work", async ({
  mcpClient,
  sharedContext,
  baseUrl,
}) => {
  const page = await sharedContext.newPage();
  try {
    await page.goto(`${baseUrl}/test-page-redirect.html`);
    await page.waitForFunction(() => document.title === "ready" || document.title === "no-webmcp");

    if ((await page.title()) === "no-webmcp") {
      test.skip(true, "navigator.modelContext not available");
      return;
    }

    await waitForTools(mcpClient);

    // Call the tool that triggers a redirect to test-page-2.html.
    // The execute() returns before the navigation happens, so the call succeeds.
    // Then the page navigates, destroying the old content script.
    const result = await mcpClient.callTool({
      name: "e2e_redirect",
      arguments: { target: `${baseUrl}/test-page-2.html` },
    });

    // The call should have completed (execute returns before navigation)
    expect(result.content).toBeDefined();

    // Wait for the new page to load and register its tools
    await page.waitForFunction(() => document.title === "ready");
    await waitForTool(mcpClient, "e2e_greet");

    // The critical test: can we actually CALL a tool on the new page?
    // This is where the connector breaks — after redirect, tool calls may fail.
    const greetResult = await mcpClient.callTool({
      name: "e2e_greet",
      arguments: { name: "World" },
    });

    const text = (greetResult.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ greeting: "Hello, World!" });
  } finally {
    await page.close();
  }
});

test("tool call works after multiple rapid navigations", async ({
  mcpClient,
  sharedContext,
  baseUrl,
}) => {
  const page = await sharedContext.newPage();
  try {
    await page.goto(`${baseUrl}/test-page.html`);
    await page.waitForFunction(() => document.title === "ready" || document.title === "no-webmcp");

    if ((await page.title()) === "no-webmcp") {
      test.skip(true, "navigator.modelContext not available");
      return;
    }

    await waitForTools(mcpClient);

    // Rapid navigations — simulates user clicking through pages
    await page.goto(`${baseUrl}/test-page-2.html`);
    await page.goto(`${baseUrl}/test-page.html`);
    await page.goto(`${baseUrl}/test-page-2.html`);
    await page.waitForFunction(() => document.title === "ready");

    // Wait for tools to stabilize
    await waitForTool(mcpClient, "e2e_greet");

    // The tool should be callable
    const result = await mcpClient.callTool({
      name: "e2e_greet",
      arguments: { name: "Test" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ greeting: "Hello, Test!" });
  } finally {
    await page.close();
  }
});
