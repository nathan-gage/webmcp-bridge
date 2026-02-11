/**
 * Security primitives for the WebMCP bridge.
 * Handles token generation, secure file/directory management, and origin validation.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile, unlink, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** Default directory for WebMCP discovery files */
export const WEBMCP_DIR = join(homedir(), ".webmcp");

/** Generate a cryptographically secure 64-character hex token */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Create the secure directory with mode 0700, verifying permissions on existing dirs */
export async function ensureSecureDir(dir: string = WEBMCP_DIR): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir may not update mode on an existing directory, so verify and fix
  const stats = await stat(dir);
  if ((stats.mode & 0o777) !== 0o700) {
    await chmod(dir, 0o700);
  }
}

/** Write data to a file with mode 0600 (owner read/write only) */
export async function writeSecureFile(filePath: string, data: string): Promise<void> {
  await writeFile(filePath, data, { mode: 0o600 });
}

/** Remove port and token discovery files */
export async function cleanup(dir: string = WEBMCP_DIR): Promise<void> {
  for (const name of ["port", "token"]) {
    try {
      await unlink(join(dir, name));
    } catch {
      // Ignore missing files
    }
  }
}

/**
 * Validate that an origin is allowed to access the bootstrap endpoint.
 * Accepts: chrome-extension:// origins and missing origin (service workers
 * with host_permissions don't always send an Origin header).
 * Rejects: http:// and https:// origins (web pages).
 */
export function validateOrigin(origin: string | undefined): boolean {
  // No origin header — allowed (service workers, curl, local processes)
  if (!origin) return true;
  // Chrome extension origin — allowed
  if (origin.startsWith("chrome-extension://")) return true;
  // Web page origins — rejected
  return false;
}
