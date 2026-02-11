"use strict";

const port = chrome.runtime.connect({ name: "popup" });

port.onMessage.addListener((msg) => {
  if (msg.type !== "status") return;

  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("status-text");
  const tabsSection = document.getElementById("tabs-section");
  const tabsList = document.getElementById("tabs-list");
  const emptyEl = document.getElementById("empty");

  if (msg.connected) {
    statusEl.className = "status connected";
    statusText.textContent = `Connected (port ${msg.port})`;
  } else {
    statusEl.className = "status disconnected";
    statusText.textContent = "Disconnected";
  }

  tabsList.innerHTML = "";
  const activeTabs = (msg.tabs || []).filter((t) => t.tools.length > 0);

  if (activeTabs.length > 0) {
    tabsSection.hidden = false;
    emptyEl.hidden = true;

    for (const tab of activeTabs) {
      const li = document.createElement("li");
      const title = document.createElement("div");
      title.className = "tab-title";
      title.textContent = tab.title || tab.url || `Tab ${tab.tabId}`;

      const tools = document.createElement("div");
      tools.className = "tab-tools";
      tools.textContent = tab.tools.map((t) => t.name).join(", ");

      li.appendChild(title);
      li.appendChild(tools);
      tabsList.appendChild(li);
    }
  } else {
    tabsSection.hidden = true;
    emptyEl.hidden = false;
  }
});

port.postMessage({ type: "get-status" });
