/**
 * Port/token discovery file management.
 * Writes port and token to ~/.webmcp/ for the extension to discover.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { WEBMCP_DIR, ensureSecureDir, writeSecureFile, cleanup } from "./security.js";

const PORT_FILE = join(WEBMCP_DIR, "port");
const TOKEN_FILE = join(WEBMCP_DIR, "token");

/** Write port and token files to the discovery directory */
export async function writePortFile(port: number, token: string): Promise<void> {
  await ensureSecureDir(WEBMCP_DIR);
  await writeSecureFile(PORT_FILE, String(port));
  await writeSecureFile(TOKEN_FILE, token);
}

/** Read port from discovery file. Returns null if not found. */
export async function readPortFile(): Promise<number | null> {
  try {
    const content = await readFile(PORT_FILE, "utf-8");
    const port = parseInt(content.trim(), 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

/** Read token from discovery file. Returns null if not found. */
export async function readTokenFile(): Promise<string | null> {
  try {
    const content = await readFile(TOKEN_FILE, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

/** Remove port/token files and clean up */
export async function cleanupPortFile(): Promise<void> {
  await cleanup();
}
