/**
 * Launch Chrome with the WebMCP Bridge extension loaded from this worktree.
 *
 * Reuses the same Chrome discovery logic as the Playwright E2E fixtures.
 * Creates a fresh profile with the WebMCP experiment flag enabled.
 *
 * Usage:
 *   bun run chrome              # Just Chrome with extension
 *   CHROME_BIN=/path/to/chrome bun run chrome   # Use a specific binary
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EXTENSION_PATH = resolve(ROOT, "extension");

/** Discover Chrome for Testing binary from .chrome-for-testing/ */
function findCftBinary(searchRoot: string): string | null {
  const cftDir = resolve(searchRoot, ".chrome-for-testing");

  let entries: string[];
  try {
    entries = readdirSync(resolve(cftDir, "chrome"));
  } catch {
    return null;
  }

  const versionDir = entries.find(
    (e) => e.startsWith("mac_arm-") || e.startsWith("mac-") || e.startsWith("linux64-"),
  );
  if (!versionDir) return null;

  const versionPath = resolve(cftDir, "chrome", versionDir);
  const subdirs = readdirSync(versionPath);
  const chromeSubdir = subdirs.find((d) => d.startsWith("chrome-"));
  if (!chromeSubdir) return null;

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

function findChrome(): string {
  // 1. Explicit override
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  // 2. Chrome for Testing in this worktree
  const local = findCftBinary(ROOT);
  if (local) return local;

  // 3. Chrome for Testing in the main repo (for worktrees)
  //    --git-common-dir returns the shared .git dir; its parent is the main repo root.
  try {
    const gitCommonDir = Bun.spawnSync(
      ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: ROOT },
    )
      .stdout.toString()
      .trim();
    if (gitCommonDir) {
      const mainRepo = resolve(gitCommonDir, "..");
      if (mainRepo !== ROOT) {
        const main = findCftBinary(mainRepo);
        if (main) return main;
      }
    }
  } catch {
    // Not in a git repo or git not available
  }

  throw new Error(
    "No Chrome binary found.\n" +
      "  Install Chrome for Testing: bun run test:e2e:install\n" +
      "  Or set CHROME_BIN=/path/to/chrome",
  );
}

/**
 * Compute Chrome's extension ID for an unpacked extension path.
 * Chrome hashes the lowercase path with SHA-256, takes the first 32 hex chars,
 * and maps each hex digit (0-f) to a letter (a-p).
 */
function computeExtensionId(extensionPath: string): string {
  const hash = createHash("sha256").update(extensionPath.toLowerCase()).digest("hex");
  return hash
    .slice(0, 32)
    .split("")
    .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
}

const chromeBin = findChrome();
const extensionId = computeExtensionId(EXTENSION_PATH);

// Create temp profile with WebMCP flag and pinned extension
const userDataDir = mkdtempSync(resolve(tmpdir(), "webmcp-dev-"));
writeFileSync(
  resolve(userDataDir, "Local State"),
  JSON.stringify({
    browser: {
      enabled_labs_experiments: ["enable-webmcp-testing@1"],
    },
  }),
);

// Write Default profile preferences to pin the extension to the toolbar
const defaultProfileDir = resolve(userDataDir, "Default");
mkdirSync(defaultProfileDir, { recursive: true });
writeFileSync(
  resolve(defaultProfileDir, "Preferences"),
  JSON.stringify({
    extensions: {
      pinned_extensions: [extensionId],
    },
  }),
);

console.error(`Extension: ${EXTENSION_PATH}`);
console.error(`Chrome:    ${chromeBin}`);
console.error(`Profile:   ${userDataDir}`);
console.error("");

const child = spawn(
  chromeBin,
  [
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--no-first-run",
    "--disable-default-apps",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);

child.on("exit", (code) => {
  rmSync(userDataDir, { recursive: true, force: true });
  process.exit(code ?? 0);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
