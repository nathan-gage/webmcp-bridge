"use strict";

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
    startKeepalive();
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
    stopKeepalive();
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && tabs.has(tabId)) {
    // Cancel pending calls for this tab — content script is being destroyed
    for (const [callId, cTabId] of pendingCalls) {
      if (cTabId === tabId) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "tool_result",
              callId,
              error: "Page navigated during tool execution",
              isError: true,
            }),
          );
        }
        pendingCalls.delete(callId);
      }
    }

    // Page is navigating; clear tools until new ones are registered
    const tab = tabs.get(tabId);
    tab.tools = [];
    saveCachedTabs();
    sendToolsToServer();
  }
});

// --- Popup communication ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    port.onMessage.addListener((msg) => {
      if (msg.type === "get-status") {
        const tabEntries = [];
        for (const [tabId, tab] of tabs) {
          tabEntries.push({ tabId, url: tab.url, title: tab.title, tools: tab.tools });
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

loadCachedTabs().then(() => {
  ensureConnected();
});
