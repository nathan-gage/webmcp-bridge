"use strict";

/**
 * Installs a package from a specifier like "user/repo@ref".
 *
 * Flow: parse specifier → fetch manifest + scripts → validate → store
 *
 * @param {string} specifier
 * @returns {Promise<{ key: string, manifest: object, warnings: string[] }>}
 */
async function installPackage(specifier) {
  const { githubFetcher, scriptValidator } = globalThis.__webmcpExports;

  // Fetch package from GitHub
  const { owner, repo, ref, manifest, scripts } = await githubFetcher.fetchPackage(specifier);

  // Validate all scripts
  const validation = scriptValidator.validatePackageScripts(scripts);
  if (!validation.valid) {
    throw new Error(`Validation failed:\n${validation.errors.join("\n")}`);
  }

  const key = githubFetcher.packageKey(owner, repo, ref);

  // Build storage updates
  const updates = {};

  // Get existing packages
  const data = await chrome.storage.local.get("marketplace:packages");
  const packages = data["marketplace:packages"] || {};

  // Store package metadata
  packages[key] = {
    id: `${owner}/${repo}`,
    ref,
    manifest,
    installedAt: Date.now(),
    enabled: true,
  };
  updates["marketplace:packages"] = packages;

  // Store each script's code separately (keeps individual items small)
  for (const script of manifest.scripts) {
    const code = scripts.get(script.id);
    const storageKey = `marketplace:script:${key}/${script.id}`;
    updates[storageKey] = {
      code,
      hash: await hashCode(code),
      matches: script.matches,
      runAt: script.runAt || "document_idle",
    };
  }

  await chrome.storage.local.set(updates);

  return { key, manifest, warnings: validation.warnings };
}

/**
 * Installs a package from a pre-loaded manifest and scripts map.
 * Used for local folder installs where files are read client-side.
 *
 * @param {object} manifest - Parsed webmcp-bridge.json
 * @param {Map<string, string>} scripts - scriptId → code
 * @returns {Promise<{ key: string, manifest: object, warnings: string[] }>}
 */
async function installLocal(manifest, scripts) {
  const { githubFetcher, scriptValidator } = globalThis.__webmcpExports;

  githubFetcher.validateManifest(manifest);

  const validation = scriptValidator.validatePackageScripts(scripts);
  if (!validation.valid) {
    throw new Error(`Validation failed:\n${validation.errors.join("\n")}`);
  }

  const key = `local/${manifest.name}@local`;

  const updates = {};
  const data = await chrome.storage.local.get("marketplace:packages");
  const packages = data["marketplace:packages"] || {};

  packages[key] = {
    id: `local/${manifest.name}`,
    ref: "local",
    manifest,
    installedAt: Date.now(),
    enabled: true,
  };
  updates["marketplace:packages"] = packages;

  for (const script of manifest.scripts) {
    const code = scripts.get(script.id);
    if (!code) throw new Error(`Missing script code for "${script.id}"`);
    const storageKey = `marketplace:script:${key}/${script.id}`;
    updates[storageKey] = {
      code,
      hash: await hashCode(code),
      matches: script.matches,
      runAt: script.runAt || "document_idle",
    };
  }

  await chrome.storage.local.set(updates);

  return { key, manifest, warnings: validation.warnings };
}

/**
 * Uninstalls a package by its storage key.
 *
 * @param {string} key - "owner/repo@ref"
 */
async function uninstallPackage(key) {
  const data = await chrome.storage.local.get("marketplace:packages");
  const packages = data["marketplace:packages"] || {};
  const pkg = packages[key];

  if (!pkg) return;

  // Collect all storage keys to remove
  const keysToRemove = [];
  for (const script of pkg.manifest.scripts) {
    keysToRemove.push(`marketplace:script:${key}/${script.id}`);
  }

  // Remove package entry
  delete packages[key];

  await chrome.storage.local.set({ "marketplace:packages": packages });
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

/**
 * Toggles a package's enabled state.
 *
 * @param {string} key - "owner/repo@ref"
 * @param {boolean} enabled
 */
async function togglePackage(key, enabled) {
  const data = await chrome.storage.local.get("marketplace:packages");
  const packages = data["marketplace:packages"] || {};

  if (!packages[key]) {
    throw new Error(`Package "${key}" not found`);
  }

  packages[key].enabled = enabled;
  await chrome.storage.local.set({ "marketplace:packages": packages });
}

/**
 * Lists all installed packages.
 *
 * @returns {Promise<Array<{ key: string, id: string, ref: string, manifest: object, enabled: boolean, installedAt: number }>>}
 */
async function listPackages() {
  const data = await chrome.storage.local.get("marketplace:packages");
  const packages = data["marketplace:packages"] || {};
  const result = [];

  for (const [key, pkg] of Object.entries(packages)) {
    result.push({
      key,
      id: pkg.id,
      ref: pkg.ref,
      manifest: pkg.manifest,
      enabled: pkg.enabled,
      installedAt: pkg.installedAt,
    });
  }

  return result;
}

/**
 * Computes a SHA-256 hash of code for integrity checking.
 *
 * @param {string} code
 * @returns {Promise<string>}
 */
async function hashCode(code) {
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "sha256-" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

if (typeof globalThis.__webmcpExports === "undefined") {
  globalThis.__webmcpExports = {};
}
globalThis.__webmcpExports.packageManager = {
  installPackage,
  installLocal,
  uninstallPackage,
  togglePackage,
  listPackages,
  hashCode,
};
