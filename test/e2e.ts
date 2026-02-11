/**
 * E2E test: spawn bridge, connect MCP client, list tools, call one.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "cli/src/index.ts"],
    cwd: import.meta.dirname + "/..",
  });

  const client = new Client({ name: "e2e-test", version: "1.0.0" });
  await client.connect(transport);
  console.log("MCP connected");

  // Wait for extension to connect and register tools
  // Extension needs time to discover the new CLI port (exponential backoff)
  console.log("Waiting 15s for extension to discover and connect...");
  await new Promise((r) => setTimeout(r, 15000));

  // List tools
  const { tools } = await client.listTools();
  console.log(`\nFound ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description}`);
  }

  if (tools.length <= 1) {
    console.log("\nOnly status tool found — make sure demo page is open.");
    await client.close();
    process.exit(1);
  }

  // Find searchFlights tool
  const tool = tools.find((t) => t.name === "searchFlights");
  if (!tool) {
    console.log("\nsearchFlights tool not found");
    await client.close();
    process.exit(1);
  }

  console.log(`\nCalling tool: ${tool.name}`);
  const result = await client.callTool({
    name: tool.name,
    arguments: {
      origin: "SFO",
      destination: "JFK",
      departureDate: "2026-03-15",
    },
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));

  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
