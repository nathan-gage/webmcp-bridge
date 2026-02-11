"use strict";

/**
 * Parses a package specifier like "user/repo@ref" into its components.
 * Supports: user/repo@v1.0.0, user/repo@main, user/repo@abc123, user/repo
 *
 * @param {string} specifier
 * @returns {{ owner: string, repo: string, ref: string | null }}
 */
function parsePackageSpecifier(specifier) {
  const trimmed = specifier.trim();
  if (!trimmed) throw new Error("Empty package specifier");

  const atIndex = trimmed.indexOf("@");
  let slug, ref;

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

/**
 * Builds the storage key for a package: "owner/repo@ref"
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref
 * @returns {string}
 */
function packageKey(owner, repo, ref) {
  return `${owner}/${repo}@${ref}`;
}

/**
 * Fetches a file from a GitHub repo via the Contents API.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - File path within the repo
 * @param {string} ref - Branch, tag, or SHA
 * @returns {Promise<string>} File contents as UTF-8 text
 */
async function fetchGitHubFile(owner, repo, path, ref) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3.raw" },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} fetching ${owner}/${repo}/${path}@${ref}`);
  }

  return res.text();
}

/**
 * Fetches and parses a webmcp-bridge.json manifest from a GitHub repo.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<object>} Parsed manifest
 */
async function fetchManifest(owner, repo, ref) {
  const text = await fetchGitHubFile(owner, repo, "webmcp-bridge.json", ref);
  let manifest;

  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in webmcp-bridge.json for ${owner}/${repo}@${ref}`);
  }

  validateManifest(manifest);
  return manifest;
}

/**
 * Validates a parsed manifest object.
 *
 * @param {object} manifest
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest must be an object");
  }
  if (typeof manifest.name !== "string" || !manifest.name) {
    throw new Error("Manifest must have a non-empty 'name' string");
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("Manifest must have a non-empty 'version' string");
  }
  if (!Array.isArray(manifest.scripts) || manifest.scripts.length === 0) {
    throw new Error("Manifest must have a non-empty 'scripts' array");
  }

  for (const script of manifest.scripts) {
    if (typeof script.id !== "string" || !script.id) {
      throw new Error("Each script must have a non-empty 'id'");
    }
    if (typeof script.file !== "string" || !script.file) {
      throw new Error(`Script "${script.id}" must have a non-empty 'file' path`);
    }
    if (!Array.isArray(script.matches) || script.matches.length === 0) {
      throw new Error(`Script "${script.id}" must have a non-empty 'matches' array`);
    }
  }
}

/**
 * Resolves the ref when none is specified. Tries latest release first,
 * falls back to the default branch.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string>}
 */
async function resolveDefaultRef(owner, repo) {
  // Try latest release
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tag_name) return data.tag_name;
    }
  } catch {
    // Fall through to default branch
  }

  // Fall back to repo default branch
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} fetching repo info for ${owner}/${repo}`);
  }
  const data = await res.json();
  return data.default_branch || "main";
}

/**
 * Fetches a complete package: manifest + all script files.
 *
 * @param {string} specifier - "owner/repo@ref" or "owner/repo"
 * @returns {Promise<{ owner: string, repo: string, ref: string, manifest: object, scripts: Map<string, string> }>}
 */
async function fetchPackage(specifier) {
  const { owner, repo, ref: rawRef } = parsePackageSpecifier(specifier);
  const ref = rawRef || (await resolveDefaultRef(owner, repo));

  const manifest = await fetchManifest(owner, repo, ref);

  const scripts = new Map();
  for (const script of manifest.scripts) {
    const code = await fetchGitHubFile(owner, repo, script.file, ref);
    scripts.set(script.id, code);
  }

  return { owner, repo, ref, manifest, scripts };
}

// Exported for use by other extension modules and tests
if (typeof globalThis.__webmcpExports === "undefined") {
  globalThis.__webmcpExports = {};
}
globalThis.__webmcpExports.githubFetcher = {
  parsePackageSpecifier,
  packageKey,
  fetchGitHubFile,
  fetchManifest,
  validateManifest,
  resolveDefaultRef,
  fetchPackage,
};
