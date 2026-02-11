import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateToken,
  ensureSecureDir,
  writeSecureFile,
  cleanup,
  validateOrigin,
} from "../../cli/src/security.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "webmcp-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("generateToken", () => {
  test("returns a 64-character hex string", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns unique tokens each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe("ensureSecureDir", () => {
  test("creates directory with mode 0700", async () => {
    const dir = join(tempDir, "secure");
    await ensureSecureDir(dir);

    const stats = await stat(dir);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  test("fixes permissions on existing directory", async () => {
    const dir = join(tempDir, "existing");
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(dir, { mode: 0o755 });

    await ensureSecureDir(dir);

    const stats = await stat(dir);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  test("handles nested paths with recursive creation", async () => {
    const dir = join(tempDir, "a", "b", "c");
    await ensureSecureDir(dir);

    const stats = await stat(dir);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
  });
});

describe("writeSecureFile", () => {
  test("creates file with mode 0600", async () => {
    const filePath = join(tempDir, "secret");
    await writeSecureFile(filePath, "hello");

    const stats = await stat(filePath);
    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("writes correct content", async () => {
    const filePath = join(tempDir, "data");
    await writeSecureFile(filePath, "test-content");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("test-content");
  });
});

describe("cleanup", () => {
  test("removes port and token files", async () => {
    const portFile = join(tempDir, "port");
    const tokenFile = join(tempDir, "token");
    await writeSecureFile(portFile, "3000");
    await writeSecureFile(tokenFile, "abc123");

    await cleanup(tempDir);

    await expect(stat(portFile)).rejects.toThrow();
    await expect(stat(tokenFile)).rejects.toThrow();
  });

  test("does not throw if files are missing", async () => {
    await expect(cleanup(tempDir)).resolves.toBeUndefined();
  });
});

describe("validateOrigin", () => {
  test("accepts chrome-extension:// origins", () => {
    expect(validateOrigin("chrome-extension://abcdefghijklmnop")).toBe(true);
    expect(validateOrigin("chrome-extension://some-id/page.html")).toBe(true);
  });

  test("rejects http origins", () => {
    expect(validateOrigin("http://example.com")).toBe(false);
  });

  test("rejects https origins", () => {
    expect(validateOrigin("https://example.com")).toBe(false);
  });

  test("accepts undefined (service workers without Origin header)", () => {
    expect(validateOrigin(undefined)).toBe(true);
  });

  test("accepts empty string (missing Origin)", () => {
    expect(validateOrigin("")).toBe(true);
  });

  test("rejects file:// origins", () => {
    expect(validateOrigin("file:///etc/passwd")).toBe(false);
  });
});
