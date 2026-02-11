"use strict";

const PORT_MIN = 13100;
const PORT_MAX = 13199;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let connectedPort = null;
let authToken = null;

// tabId → { url, title, tools: [{name, description, schema}] }
const tabs = new Map();

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

function sendToolsToServer() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const tools = getAggregatedTools().map(({ _tabId, ...rest }) => rest);
  ws.send(JSON.stringify({ type: "register_tools", tools }));
  updateBadge();
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
    sendToolsToServer();
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

  chrome.tabs.sendMessage(targetTabId, {
    type: "execute-tool",
    callId,
    toolName: name,
    args: args || {},
  });
}

// --- Content script message handling ---

chrome.runtime.onMessage.addListener((message, sender) => {
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

    sendToolsToServer();
  }

  if (message.type === "tool-result") {
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
    sendToolsToServer();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && tabs.has(tabId)) {
    // Page is navigating; clear tools until new ones are registered
    const tab = tabs.get(tabId);
    tab.tools = [];
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

discoverAndConnect();
