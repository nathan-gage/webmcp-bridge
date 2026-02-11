import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  retries: 0,
});
