"use strict";

// --- Marketplace libs ---
// Loaded via importScripts since MV3 service workers don't support ES modules
try {
  importScripts(
    "lib/github-fetcher.js",
    "lib/script-validator.js",
    "lib/package-manager.js",
    "lib/script-injector.js",
  );
} catch (e) {
  console.error("Failed to load marketplace libs:", e);
}

const PORT_MIN = 13100;
const PORT_MAX = 13199;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_ALARM = "keepalive";
const KEEPALIVE_PERIOD_MIN = 0.4; // ~25s
const SEND_TOOLS_DEBOUNCE_MS = 150;
const SAVE_TABS_DEBOUNCE_MS = 500;

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let connectedPort = null;
let authToken = null;
let reconnectPending = false;

// tabId → { url, title, tools: [{name, description, inputSchema}] }
// This is the authoritative tool state. Persisted to chrome.storage.session
// so it survives service worker suspension/restart.
const tabs = new Map();

// callId → tabId — tracks pending tool calls so we can cancel them on navigation
const pendingCalls = new Map();

// --- Tab state persistence ---
// chrome.storage.session survives SW restarts within a browser session.

let saveTimer = null;

function saveCachedTabs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const obj = {};
    for (const [tabId, tab] of tabs) {
      obj[tabId] = tab;
    }
    chrome.storage.session.set({ cachedTabs: obj }).catch(() => {});
  }, SAVE_TABS_DEBOUNCE_MS);
}

async function loadCachedTabs() {
  try {
    const data = await chrome.storage.session.get("cachedTabs");
    if (data.cachedTabs) {
      for (const [tabId, tab] of Object.entries(data.cachedTabs)) {
        tabs.set(Number(tabId), tab);
      }
    }
  } catch {
    // Storage not available or corrupted — start fresh
  }

  // Remove entries for tabs that no longer exist
  try {
    const allTabs = await chrome.tabs.query({});
    const openTabIds = new Set(allTabs.map((t) => t.id));
    for (const tabId of tabs.keys()) {
      if (!openTabIds.has(tabId)) {
        tabs.delete(tabId);
      }
    }
  } catch {
    // tabs.query failed — keep what we have
  }
}

// --- Badge management ---

function updateBadge() {
  let totalTools = 0;
  for (const tab of tabs.values()) {
    totalTools += tab.tools.length;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    chrome.action.setBadgeText({ text: totalTools > 0 ? String(totalTools) : "" });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: "#888" });
    chrome.action.setBadgeText({ text: "" });
  }
}

// --- Tool aggregation ---

function getAggregatedTools() {
  const tools = [];
  for (const [tabId, tab] of tabs) {
    for (const tool of tab.tools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        _tabId: tabId,
      });
    }
  }
  return tools;
}

/** Send full tool list to CLI immediately (no debounce) */
function sendToolsNow() {
  // Cancel any pending debounced send — we're sending the latest state now
  clearTimeout(sendToolsTimer);
  sendToolsTimer = null;

  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const tools = getAggregatedTools().map(({ _tabId, ...rest }) => rest);
  ws.send(JSON.stringify({ type: "register_tools", tools }));
  updateBadge();
}

let sendToolsTimer = null;

/** Send full tool list to CLI (debounced — for rapid changes during navigation) */
function sendToolsToServer() {
  clearTimeout(sendToolsTimer);
  sendToolsTimer = setTimeout(() => {
    sendToolsNow();
  }, SEND_TOOLS_DEBOUNCE_MS);
}

// --- Keepalive alarm ---

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    // Send a ping to keep the service worker active (prevents Chrome from
    // suspending the SW and killing the WebSocket due to inactivity)
    ws.send(JSON.stringify({ type: "ping" }));
  } else {
    ensureConnected();
  }
});

// --- Connection management ---

function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (reconnectPending || reconnectTimer) return;

  reconnectPending = true;
  discoverAndConnect().finally(() => {
    reconnectPending = false;
  });
}

// --- Port discovery ---

async function discoverAndConnect() {
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/.well-known/webmcp-bridge`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) continue;

      const data = await res.json();
      if (!data.token) continue;

      connectWS(port, data.token);
      return;
    } catch {
      // Port not available, try next
    }
  }

  // No server found, schedule retry
  scheduleReconnect();
}

// --- Tab re-polling ---

function repollAllTabs() {
  chrome.tabs.query({}, (allTabs) => {
    for (const tab of allTabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "re-poll-tools" }).catch(() => {
        // Tab doesn't have content script loaded — ignore
      });
    }
  });
}

// --- WebSocket connection ---

function connectWS(port, token) {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }

  connectedPort = port;
  authToken = token;
  ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    reconnectAttempt = 0;
    updateBadge();
    // Push cached tools immediately if we have any (fast restore).
    if (getAggregatedTools().length > 0) {
      sendToolsNow();
    }
    // Repoll all tabs for freshness. Content scripts will respond with
    // tools-changed messages, triggering sendToolsToServer() automatically.
    repollAllTabs();
    // Safety net: after giving repoll time to complete, send the current
    // tool state regardless. This handles cases where:
    // - repoll found new tools that weren't in the cache
    // - no content scripts responded but we need to confirm the state
    // - timing issues caused the initial debounced sends to miss
    setTimeout(() => sendToolsToServer(), 500);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "execute_tool") {
      handleExecuteTool(msg);
    } else if (msg.type === "get_tools") {
      handleGetTools(msg);
    }
  };

  ws.onclose = () => {
    ws = null;
    connectedPort = null;
    authToken = null;
    updateBadge();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
  reconnectAttempt++;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    discoverAndConnect();
  }, delay);
}

// --- Handle get_tools request from CLI (pull-based supplement) ---

function handleGetTools(msg) {
  const { requestId } = msg;

  const tools = getAggregatedTools().map(({ _tabId, ...rest }) => rest);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "tools_list", requestId, tools }));
  }
}

// --- Execute tool routing ---

function handleExecuteTool(msg) {
  const { callId, name, arguments: args } = msg;

  // Find which tab has this tool
  let targetTabId = null;
  for (const [tabId, tab] of tabs) {
    if (tab.tools.some((t) => t.name === name)) {
      targetTabId = tabId;
      break;
    }
  }

  if (targetTabId === null) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "tool_result",
          callId,
          error: `Tool "${name}" not found in any tab`,
        }),
      );
    }
    return;
  }

  pendingCalls.set(callId, targetTabId);

  chrome.tabs
    .sendMessage(targetTabId, {
      type: "execute-tool",
      callId,
      toolName: name,
      args: args || {},
    })
    .catch((err) => {
      pendingCalls.delete(callId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "tool_result",
            callId,
            error: `Failed to reach tab: ${err.message}`,
            isError: true,
          }),
        );
      }
    });
}

// --- Marketplace message handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "marketplace:install") {
    handleMarketplaceInstall(message, sendResponse);
    return true; // async response
  }
  if (message.type === "marketplace:uninstall") {
    handleMarketplaceUninstall(message, sendResponse);
    return true;
  }
  if (message.type === "marketplace:toggle") {
    handleMarketplaceToggle(message, sendResponse);
    return true;
  }
  if (message.type === "marketplace:install-local") {
    handleMarketplaceInstallLocal(message, sendResponse);
    return true;
  }
  if (message.type === "marketplace:list") {
    handleMarketplaceList(sendResponse);
    return true;
  }
});

async function handleMarketplaceInstall(message, sendResponse) {
  try {
    const { packageManager } = globalThis.__webmcpExports;
    const result = await packageManager.installPackage(message.specifier);
    await injectIntoMatchingTabs();
    sendResponse({ success: true, key: result.key, warnings: result.warnings });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

async function handleMarketplaceInstallLocal(message, sendResponse) {
  try {
    const { packageManager } = globalThis.__webmcpExports;
    const scripts = new Map(Object.entries(message.scripts));
    const result = await packageManager.installLocal(message.manifest, scripts);
    await injectIntoMatchingTabs();
    sendResponse({ success: true, key: result.key, warnings: result.warnings });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

/** Inject matching marketplace scripts into all currently open tabs. */
async function injectIntoMatchingTabs() {
  const { scriptInjector } = globalThis.__webmcpExports;
  if (!scriptInjector) return;

  try {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (!tab.id || !tab.url) continue;
      const scripts = await scriptInjector.getMatchingScripts(tab.url, "document_idle");
      for (const { code } of scripts) {
        try {
          await scriptInjector.injectScript(tab.id, code);
        } catch {
          // Tab may not be injectable (chrome://, extension pages, etc.)
        }
      }
    }
  } catch {
    // tabs.query failed
  }
}

async function handleMarketplaceUninstall(message, sendResponse) {
  try {
    const { packageManager } = globalThis.__webmcpExports;
    await packageManager.uninstallPackage(message.key);
    sendResponse({ success: true });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

async function handleMarketplaceToggle(message, sendResponse) {
  try {
    const { packageManager } = globalThis.__webmcpExports;
    await packageManager.togglePackage(message.key, message.enabled);
    sendResponse({ success: true });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

async function handleMarketplaceList(sendResponse) {
  try {
    const { packageManager } = globalThis.__webmcpExports;
    const packages = await packageManager.listPackages();
    sendResponse({ success: true, packages });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

// --- Content script message handling ---

chrome.runtime.onMessage.addListener((message, sender) => {
  // Reconnect on wake-up if WS is dead
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    ensureConnected();
  }

  if (!sender.tab) return;

  const tabId = sender.tab.id;

  if (message.type === "tools-changed") {
    const existing = tabs.get(tabId) || {
      url: sender.tab.url,
      title: sender.tab.title,
      tools: [],
    };

    existing.url = sender.tab.url;
    existing.title = sender.tab.title;
    existing.tools = message.tools || [];
    existing.isNative = message.isNative ?? true;
    tabs.set(tabId, existing);

    saveCachedTabs();
    sendToolsToServer();
  }

  if (message.type === "tool-result") {
    pendingCalls.delete(message.callId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "tool_result",
          callId: message.callId,
          result: message.result,
          error: message.error,
        }),
      );
    }
  }
});

// --- Tab lifecycle ---

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) {
    tabs.delete(tabId);
    saveCachedTabs();
    sendToolsToServer();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tabs.has(tabId)) {
    // Don't cancel pending calls — the tool result may still arrive after
    // SPA navigation. The CLI applies a grace period timeout instead.

    // Page is navigating; clear tools until new ones are registered
    const tabState = tabs.get(tabId);
    tabState.tools = [];
    saveCachedTabs();
    sendToolsToServer();
  }

  // Inject matching marketplace scripts
  if (globalThis.__webmcpExports && globalThis.__webmcpExports.scriptInjector) {
    globalThis.__webmcpExports.scriptInjector.onTabUpdated(tabId, changeInfo, tab).catch(() => {});
  }
});

// --- Popup communication ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    port.onMessage.addListener((msg) => {
      if (msg.type === "get-status") {
        const tabEntries = [];
        for (const [tabId, tab] of tabs) {
          tabEntries.push({
            tabId,
            url: tab.url,
            title: tab.title,
            tools: tab.tools,
            isNative: tab.isNative,
          });
        }
        port.postMessage({
          type: "status",
          connected: ws !== null && ws.readyState === WebSocket.OPEN,
          port: connectedPort,
          tabs: tabEntries,
        });
      }
    });
  }
});

// --- Start ---
// Load persisted tab state, then connect to CLI.

startKeepalive();
loadCachedTabs().then(() => {
  ensureConnected();
});
