import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: {
    alias: { "bun:test": resolve(import.meta.dirname!, "test/vitest-shim.ts") },
  },
});
