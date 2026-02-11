"use strict";

/**
 * Converts a match pattern (like Chrome extension match patterns) to a RegExp.
 * Supports: *://host/path, http://host/path, https://host/path, <all_urls>
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function matchPatternToRegExp(pattern) {
  if (pattern === "<all_urls>") {
    return /^https?:\/\/.*/;
  }

  // Match pattern format: scheme://host/path
  const match = pattern.match(/^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)?$/);
  if (!match) {
    throw new Error(`Invalid match pattern: "${pattern}"`);
  }

  const [, scheme, host, path] = match;

  let regex = "^";

  // Scheme
  if (scheme === "*") {
    regex += "https?";
  } else {
    regex += scheme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += ":\\/\\/";

  // Host
  if (host === "*") {
    regex += "[^/]+";
  } else if (host.startsWith("*.")) {
    const baseDomain = host.slice(2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex += `([^/]+\\.)?${baseDomain}`;
  } else {
    regex += host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Path
  if (!path || path === "/*" || path === "/") {
    regex += "(\\/.*)?";
  } else {
    // Escape special chars, then convert * to .*
    regex += path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  }

  regex += "$";
  return new RegExp(regex);
}

/**
 * Tests whether a URL matches any of the given match patterns.
 *
 * @param {string} url
 * @param {string[]} patterns
 * @returns {boolean}
 */
function urlMatchesPatterns(url, patterns) {
  for (const pattern of patterns) {
    try {
      if (matchPatternToRegExp(pattern).test(url)) return true;
    } catch {
      // Invalid pattern — skip
    }
  }
  return false;
}

/**
 * Gets all installed scripts that match a given URL and runAt timing.
 * Reads from chrome.storage.local.
 *
 * @param {string} url
 * @param {string} runAt - "document_idle" or "document_start"
 * @returns {Promise<Array<{ scriptId: string, code: string }>>}
 */
async function getMatchingScripts(url, runAt) {
  const data = await chrome.storage.local.get(null);
  const packages = data["marketplace:packages"] || {};
  const matching = [];

  for (const [pkgKey, pkg] of Object.entries(packages)) {
    if (!pkg.enabled) continue;

    for (const script of pkg.manifest.scripts) {
      const scriptRunAt = script.runAt || "document_idle";
      if (scriptRunAt !== runAt) continue;
      if (!urlMatchesPatterns(url, script.matches)) continue;

      const storageKey = `marketplace:script:${pkgKey}/${script.id}`;
      const scriptData = data[storageKey];
      if (scriptData && scriptData.code) {
        matching.push({ scriptId: `${pkgKey}/${script.id}`, code: scriptData.code });
      }
    }
  }

  return matching;
}

/**
 * Injects a script into a tab using chrome.scripting.executeScript.
 * The script runs in the MAIN world so it has access to navigator.modelContext.
 *
 * @param {number} tabId
 * @param {string} code
 */
async function injectScript(tabId, code) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (scriptCode) => {
      const fn = new Function(scriptCode);
      fn();
    },
    args: [code],
  });
}

/**
 * Handles tab update events and injects matching scripts.
 * Called from background.js's tabs.onUpdated listener.
 *
 * @param {number} tabId
 * @param {object} changeInfo
 * @param {object} tab
 */
async function onTabUpdated(tabId, changeInfo, tab) {
  if (!tab.url) return;

  // document_start scripts inject during "loading"
  if (changeInfo.status === "loading") {
    const scripts = await getMatchingScripts(tab.url, "document_start");
    for (const { code } of scripts) {
      try {
        await injectScript(tabId, code);
      } catch {
        // Tab may have navigated away or been closed
      }
    }
  }

  // document_idle scripts inject when "complete"
  if (changeInfo.status === "complete") {
    const scripts = await getMatchingScripts(tab.url, "document_idle");
    for (const { code } of scripts) {
      try {
        await injectScript(tabId, code);
      } catch {
        // Tab may have navigated away or been closed
      }
    }
  }
}

if (typeof globalThis.__webmcpExports === "undefined") {
  globalThis.__webmcpExports = {};
}
globalThis.__webmcpExports.scriptInjector = {
  matchPatternToRegExp,
  urlMatchesPatterns,
  getMatchingScripts,
  injectScript,
  onTabUpdated,
};
