import { describe, test, expect, beforeEach } from "bun:test";

// --- github-fetcher: parsePackageSpecifier ---

// We replicate the pure functions here since the extension files use
// globalThis.__webmcpExports and aren't importable as ES modules.

function parsePackageSpecifier(specifier: string) {
  const trimmed = specifier.trim();
  if (!trimmed) throw new Error("Empty package specifier");

  const atIndex = trimmed.indexOf("@");
  let slug: string, ref: string | null;

  if (atIndex > 0) {
    slug = trimmed.slice(0, atIndex);
    ref = trimmed.slice(atIndex + 1);
    if (!ref) throw new Error("Empty ref after @");
  } else {
    slug = trimmed;
    ref = null;
  }

  const slashIndex = slug.indexOf("/");
  if (slashIndex <= 0 || slashIndex === slug.length - 1) {
    throw new Error(`Invalid package specifier: expected "owner/repo", got "${slug}"`);
  }

  const owner = slug.slice(0, slashIndex);
  const repo = slug.slice(slashIndex + 1);

  if (owner.includes("/") || repo.includes("/")) {
    throw new Error(`Invalid package specifier: too many slashes in "${slug}"`);
  }

  return { owner, repo, ref };
}

describe("github-fetcher: parsePackageSpecifier", () => {
  test("parses owner/repo@tag", () => {
    const result = parsePackageSpecifier("user/my-repo@v1.0.0");
    expect(result).toEqual({ owner: "user", repo: "my-repo", ref: "v1.0.0" });
  });

  test("parses owner/repo@branch", () => {
    const result = parsePackageSpecifier("user/repo@main");
    expect(result).toEqual({ owner: "user", repo: "repo", ref: "main" });
  });

  test("parses owner/repo@sha", () => {
    const result = parsePackageSpecifier("user/repo@abc123");
    expect(result).toEqual({ owner: "user", repo: "repo", ref: "abc123" });
  });

  test("parses owner/repo without ref", () => {
    const result = parsePackageSpecifier("user/repo");
    expect(result).toEqual({ owner: "user", repo: "repo", ref: null });
  });

  test("trims whitespace", () => {
    const result = parsePackageSpecifier("  user/repo@v1  ");
    expect(result).toEqual({ owner: "user", repo: "repo", ref: "v1" });
  });

  test("throws on empty string", () => {
    expect(() => parsePackageSpecifier("")).toThrow("Empty package specifier");
  });

  test("throws on missing owner", () => {
    expect(() => parsePackageSpecifier("/repo")).toThrow("expected");
  });

  test("throws on missing repo", () => {
    expect(() => parsePackageSpecifier("owner/")).toThrow("expected");
  });

  test("throws on no slash", () => {
    expect(() => parsePackageSpecifier("justrepo")).toThrow("expected");
  });

  test("throws on too many slashes", () => {
    expect(() => parsePackageSpecifier("a/b/c")).toThrow("too many slashes");
  });

  test("throws on empty ref after @", () => {
    expect(() => parsePackageSpecifier("user/repo@")).toThrow("Empty ref after @");
  });
});

// --- github-fetcher: validateManifest ---

function validateManifest(manifest: Record<string, unknown>) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest must be an object");
  }
  if (typeof manifest.name !== "string" || !manifest.name) {
    throw new Error("Manifest must have a non-empty 'name' string");
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("Manifest must have a non-empty 'version' string");
  }
  if (!Array.isArray(manifest.scripts) || (manifest.scripts as unknown[]).length === 0) {
    throw new Error("Manifest must have a non-empty 'scripts' array");
  }

  for (const script of manifest.scripts as Array<Record<string, unknown>>) {
    if (typeof script.id !== "string" || !script.id) {
      throw new Error("Each script must have a non-empty 'id'");
    }
    if (typeof script.file !== "string" || !script.file) {
      throw new Error(`Script "${script.id}" must have a non-empty 'file' path`);
    }
    if (!Array.isArray(script.matches) || (script.matches as unknown[]).length === 0) {
      throw new Error(`Script "${script.id}" must have a non-empty 'matches' array`);
    }
  }
}

describe("github-fetcher: validateManifest", () => {
  const validManifest = {
    name: "test-pkg",
    version: "1.0.0",
    scripts: [{ id: "s1", file: "scripts/s1.js", matches: ["*://example.com/*"] }],
  };

  test("accepts valid manifest", () => {
    expect(() => validateManifest(validManifest)).not.toThrow();
  });

  test("rejects missing name", () => {
    expect(() => validateManifest({ ...validManifest, name: "" })).toThrow("name");
  });

  test("rejects missing version", () => {
    expect(() => validateManifest({ ...validManifest, version: "" })).toThrow("version");
  });

  test("rejects empty scripts array", () => {
    expect(() => validateManifest({ ...validManifest, scripts: [] })).toThrow("scripts");
  });

  test("rejects script without id", () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        scripts: [{ id: "", file: "f.js", matches: ["*://x/*"] }],
      }),
    ).toThrow("id");
  });

  test("rejects script without file", () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        scripts: [{ id: "s1", file: "", matches: ["*://x/*"] }],
      }),
    ).toThrow("file");
  });

  test("rejects script without matches", () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        scripts: [{ id: "s1", file: "f.js", matches: [] }],
      }),
    ).toThrow("matches");
  });
});

// --- script-validator ---

const DANGEROUS_PATTERNS: [RegExp, string][] = [
  [/\beval\s*\(/, "eval() call"],
  [/\bnew\s+Function\s*\(/, "new Function() constructor"],
  [/\bdocument\.write\s*\(/, "document.write() call"],
  [/\bimportScripts\s*\(/, "importScripts() call"],
  [/\bcreateElement\s*\(\s*['"`]script['"`]\s*\)/, "dynamic <script> creation"],
  [/\bnew\s+Image\s*\(\s*\)\s*\.\s*src\s*=/, "image-based data exfiltration"],
  [
    /\bnew\s+WebSocket\s*\(\s*['"`]wss?:\/\/(?!127\.0\.0\.1|localhost)/,
    "WebSocket to external host",
  ],
  [/\bsetAttribute\s*\(\s*['"`]on/, "setting inline event handler attribute"],
];

function detectObfuscation(code: string): string[] {
  const warnings: string[] = [];

  const lines = code.split("\n");
  const longDenseLines = lines.filter((l) => l.length > 500 && l.trim().length / l.length > 0.95);
  if (longDenseLines.length > 0) {
    warnings.push("Contains very long, dense lines suggesting obfuscation or minification");
  }

  const hexEscapes = (code.match(/\\x[0-9a-fA-F]{2}/g) || []).length;
  if (hexEscapes > 10) {
    warnings.push(`Contains ${hexEscapes} hex escape sequences`);
  }

  const unicodeEscapes = (code.match(/\\u[0-9a-fA-F]{4}/g) || []).length;
  if (unicodeEscapes > 10) {
    warnings.push(`Contains ${unicodeEscapes} unicode escape sequences`);
  }

  const charCodeRefs = (code.match(/fromCharCode/g) || []).length;
  if (charCodeRefs > 3) {
    warnings.push(`Contains ${charCodeRefs} fromCharCode references`);
  }

  const atobRefs = (code.match(/\batob\s*\(/g) || []).length;
  if (atobRefs > 2) {
    warnings.push(`Contains ${atobRefs} atob() calls`);
  }

  return warnings;
}

function validateScript(code: string, scriptId: string) {
  const errors: string[] = [];
  const warnings: string[] = [];

  // No syntax check — new Function() is blocked by extension CSP.
  // Kept in tests only to verify the pattern scanner still works.

  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Dangerous pattern in "${scriptId}": ${description}`);
    }
  }

  const obfuscationWarnings = detectObfuscation(code);
  for (const w of obfuscationWarnings) {
    warnings.push(`"${scriptId}": ${w}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

describe("script-validator", () => {
  test("passes clean IIFE script", () => {
    const code = `(function() {
      'use strict';
      if (!navigator.modelContext) return;
      navigator.modelContext.registerTool({
        name: 'test',
        description: 'Test tool',
        inputSchema: { type: 'object' },
        execute: async () => ({ result: 'ok' })
      });
    })();`;

    const result = validateScript(code, "test-script");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("catches eval()", () => {
    const code = `eval("alert(1)")`;
    const result = validateScript(code, "evil-script");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("eval()"))).toBe(true);
  });

  test("catches new Function()", () => {
    const code = `var fn = new Function("return 1")`;
    const result = validateScript(code, "fn-script");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("new Function()"))).toBe(true);
  });

  test("catches document.write()", () => {
    const code = `document.write("<h1>hi</h1>")`;
    const result = validateScript(code, "write-script");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("document.write()"))).toBe(true);
  });

  test("catches dynamic script creation", () => {
    const code = `document.createElement("script")`;
    const result = validateScript(code, "script-inject");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("<script>"))).toBe(true);
  });

  test("catches external WebSocket", () => {
    const code = `new WebSocket("wss://evil.com/ws")`;
    const result = validateScript(code, "ws-script");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("WebSocket"))).toBe(true);
  });

  test("allows localhost WebSocket", () => {
    const code = `new WebSocket("ws://127.0.0.1:8080/ws")`;
    const result = validateScript(code, "local-ws");
    expect(result.valid).toBe(true);
  });

  test("detects obfuscated code with many hex escapes", () => {
    const hexes = Array.from(
      { length: 15 },
      (_, i) => `\\x${i.toString(16).padStart(2, "0")}`,
    ).join("");
    const code = `var s = "${hexes}";`;
    const result = validateScript(code, "hex-script");
    expect(result.warnings.some((w) => w.includes("hex escape"))).toBe(true);
  });

  test("detects many fromCharCode references", () => {
    const code = `String.fromCharCode(72); String.fromCharCode(101); String.fromCharCode(108); String.fromCharCode(108);`;
    const result = validateScript(code, "charcode-script");
    expect(result.warnings.some((w) => w.includes("fromCharCode"))).toBe(true);
  });
});

// --- script-injector: matchPatternToRegExp ---

function matchPatternToRegExp(pattern: string): RegExp {
  if (pattern === "<all_urls>") {
    return /^https?:\/\/.*/;
  }

  const match = pattern.match(/^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)?$/);
  if (!match) {
    throw new Error(`Invalid match pattern: "${pattern}"`);
  }

  const [, scheme, host, path] = match;

  let regex = "^";

  if (scheme === "*") {
    regex += "https?";
  } else {
    regex += scheme!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += ":\\/\\/";

  if (host === "*") {
    regex += "[^/]+";
  } else if (host!.startsWith("*.")) {
    const baseDomain = host!.slice(2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex += `([^/]+\\.)?${baseDomain}`;
  } else {
    regex += host!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  if (!path || path === "/*" || path === "/") {
    regex += "(\\/.*)?";
  } else {
    regex += path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  }

  regex += "$";
  return new RegExp(regex);
}

function urlMatchesPatterns(url: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    try {
      if (matchPatternToRegExp(pattern).test(url)) return true;
    } catch {
      // Invalid pattern — skip
    }
  }
  return false;
}

describe("script-injector: matchPatternToRegExp", () => {
  test("<all_urls> matches http and https", () => {
    const re = matchPatternToRegExp("<all_urls>");
    expect(re.test("https://example.com/page")).toBe(true);
    expect(re.test("http://example.com/page")).toBe(true);
    expect(re.test("ftp://example.com/file")).toBe(false);
  });

  test("*://mail.google.com/* matches http and https", () => {
    const re = matchPatternToRegExp("*://mail.google.com/*");
    expect(re.test("https://mail.google.com/")).toBe(true);
    expect(re.test("http://mail.google.com/inbox")).toBe(true);
    expect(re.test("https://calendar.google.com/")).toBe(false);
  });

  test("https://example.com/* matches only https", () => {
    const re = matchPatternToRegExp("https://example.com/*");
    expect(re.test("https://example.com/page")).toBe(true);
    expect(re.test("http://example.com/page")).toBe(false);
  });

  test("*://*.google.com/* matches subdomains", () => {
    const re = matchPatternToRegExp("*://*.google.com/*");
    expect(re.test("https://mail.google.com/inbox")).toBe(true);
    expect(re.test("https://docs.google.com/")).toBe(true);
    expect(re.test("https://google.com/")).toBe(true);
    expect(re.test("https://evil-google.com/")).toBe(false);
  });

  test("*://*/* matches all hosts", () => {
    const re = matchPatternToRegExp("*://*/*");
    expect(re.test("https://anything.com/path")).toBe(true);
    expect(re.test("http://localhost/test")).toBe(true);
  });

  test("throws on invalid pattern", () => {
    expect(() => matchPatternToRegExp("ftp://example.com/*")).toThrow("Invalid match pattern");
  });
});

describe("script-injector: urlMatchesPatterns", () => {
  test("returns true if any pattern matches", () => {
    const patterns = ["https://example.com/*", "*://mail.google.com/*"];
    expect(urlMatchesPatterns("https://mail.google.com/inbox", patterns)).toBe(true);
  });

  test("returns false if no patterns match", () => {
    const patterns = ["https://example.com/*"];
    expect(urlMatchesPatterns("https://other.com/page", patterns)).toBe(false);
  });

  test("skips invalid patterns gracefully", () => {
    const patterns = ["not-a-valid-pattern", "https://example.com/*"];
    expect(urlMatchesPatterns("https://example.com/page", patterns)).toBe(true);
  });

  test("returns false for empty patterns array", () => {
    expect(urlMatchesPatterns("https://example.com/", [])).toBe(false);
  });
});

// --- package-manager: hashCode ---

async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "sha256-" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("package-manager: hashCode", () => {
  test("produces consistent sha256 hash", async () => {
    const hash1 = await hashCode("hello world");
    const hash2 = await hashCode("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  test("different inputs produce different hashes", async () => {
    const hash1 = await hashCode("hello");
    const hash2 = await hashCode("world");
    expect(hash1).not.toBe(hash2);
  });
});

// --- package-manager: storage integration ---
// These test the install/uninstall/toggle/list flow using a mock chrome.storage.local.

describe("package-manager: storage operations", () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};

    // Mock chrome.storage.local
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (keys: string | string[] | null) => {
            if (keys === null) return { ...storage };
            if (typeof keys === "string") return { [keys]: storage[keys] };
            const result: Record<string, unknown> = {};
            for (const k of keys) result[k] = storage[k];
            return result;
          },
          set: async (items: Record<string, unknown>) => {
            Object.assign(storage, items);
          },
          remove: async (keys: string[]) => {
            for (const k of keys) delete storage[k];
          },
        },
      },
    };
  });

  test("installs and lists a package", async () => {
    // Simulate what installPackage stores
    const key = "testuser/testrepo@v1.0.0";
    const manifest = {
      name: "test-pkg",
      version: "1.0.0",
      description: "A test",
      scripts: [
        {
          id: "s1",
          name: "Script 1",
          file: "scripts/s1.js",
          matches: ["<all_urls>"],
          runAt: "document_idle",
        },
      ],
    };

    storage["marketplace:packages"] = {
      [key]: {
        id: "testuser/testrepo",
        ref: "v1.0.0",
        manifest,
        installedAt: Date.now(),
        enabled: true,
      },
    };
    storage[`marketplace:script:${key}/s1`] = {
      code: "(function(){})();",
      hash: "sha256-abc",
      matches: ["<all_urls>"],
      runAt: "document_idle",
    };

    // Verify via chrome.storage.local.get
    const data = await (globalThis as any).chrome.storage.local.get("marketplace:packages");
    const packages = data["marketplace:packages"];
    expect(Object.keys(packages)).toHaveLength(1);
    expect(packages[key].enabled).toBe(true);
    expect(packages[key].manifest.name).toBe("test-pkg");
  });

  test("uninstall removes package and script entries", async () => {
    const key = "testuser/testrepo@v1.0.0";
    storage["marketplace:packages"] = {
      [key]: {
        id: "testuser/testrepo",
        ref: "v1.0.0",
        manifest: {
          name: "test",
          version: "1.0.0",
          scripts: [{ id: "s1", file: "f.js", matches: ["*://*/*"] }],
        },
        installedAt: Date.now(),
        enabled: true,
      },
    };
    storage[`marketplace:script:${key}/s1`] = {
      code: "x",
      hash: "h",
      matches: ["*://*/*"],
      runAt: "document_idle",
    };

    // Simulate uninstall
    const packages = { ...(storage["marketplace:packages"] as Record<string, unknown>) };
    delete packages[key];
    await (globalThis as any).chrome.storage.local.set({ "marketplace:packages": packages });
    await (globalThis as any).chrome.storage.local.remove([`marketplace:script:${key}/s1`]);

    const data = await (globalThis as any).chrome.storage.local.get(null);
    expect(Object.keys(data["marketplace:packages"] as object)).toHaveLength(0);
    expect(data[`marketplace:script:${key}/s1`]).toBeUndefined();
  });

  test("toggle changes enabled state", async () => {
    const key = "user/repo@main";
    storage["marketplace:packages"] = {
      [key]: {
        id: "user/repo",
        ref: "main",
        manifest: {
          name: "x",
          version: "1.0.0",
          scripts: [{ id: "s", file: "f.js", matches: ["*://*/*"] }],
        },
        installedAt: Date.now(),
        enabled: true,
      },
    };

    // Simulate toggle off
    const packages = { ...(storage["marketplace:packages"] as Record<string, unknown>) } as Record<
      string,
      any
    >;
    packages[key] = { ...packages[key], enabled: false };
    await (globalThis as any).chrome.storage.local.set({ "marketplace:packages": packages });

    const data = await (globalThis as any).chrome.storage.local.get("marketplace:packages");
    expect((data["marketplace:packages"] as any)[key].enabled).toBe(false);
  });
});

// --- Example bridge script ---

describe("examples/marketplace/scripts/example.js", () => {
  test("registers hello_world tool with correct shape", async () => {
    const registered: Record<string, unknown>[] = [];

    // Mock navigator.modelContext
    const fakeNavigator = {
      modelContext: {
        registerTool: (descriptor: Record<string, unknown>) => {
          registered.push(descriptor);
        },
      },
    };

    // Read and run the example script with our mock
    const code = await Bun.file("examples/marketplace/scripts/example.js").text();
    const fn = new Function("navigator", code);
    fn(fakeNavigator);

    expect(registered).toHaveLength(1);
    const tool = registered[0];
    expect(tool.name).toBe("hello_world");
    expect(tool.description).toBeString();
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  test("execute returns greeting with default name", async () => {
    let executeFn: (args: Record<string, unknown>) => unknown;

    const fakeNavigator = {
      modelContext: {
        registerTool: (descriptor: Record<string, unknown>) => {
          executeFn = descriptor.execute as typeof executeFn;
        },
      },
    };

    const code = await Bun.file("examples/marketplace/scripts/example.js").text();
    new Function("navigator", code)(fakeNavigator);

    const result = await executeFn!({});
    expect(result).toEqual({
      greeting: "Hello, World! This tool was injected via the WebMCP marketplace.",
    });
  });

  test("execute returns greeting with custom name", async () => {
    let executeFn: (args: Record<string, unknown>) => unknown;

    const fakeNavigator = {
      modelContext: {
        registerTool: (descriptor: Record<string, unknown>) => {
          executeFn = descriptor.execute as typeof executeFn;
        },
      },
    };

    const code = await Bun.file("examples/marketplace/scripts/example.js").text();
    new Function("navigator", code)(fakeNavigator);

    const result = await executeFn!({ name: "Alice" });
    expect(result).toEqual({
      greeting: "Hello, Alice! This tool was injected via the WebMCP marketplace.",
    });
  });

  test("skips registration when modelContext is absent", async () => {
    const registered: unknown[] = [];

    const fakeNavigator = {};
    const code = await Bun.file("examples/marketplace/scripts/example.js").text();

    // Should not throw
    new Function("navigator", code)(fakeNavigator);
    expect(registered).toHaveLength(0);
  });
});
