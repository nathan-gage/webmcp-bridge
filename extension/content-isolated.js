"use strict";

(() => {
  const NONCE = crypto.randomUUID();
  document.documentElement.dataset.webmcpNonce = NONCE;

  // Relay messages from MAIN world → background service worker
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.nonce !== NONCE) return;
    if (event.data.source !== "webmcp-main") return;

    const { nonce, source, ...payload } = event.data;
    chrome.runtime.sendMessage(payload);
  });

  // Relay messages from background → MAIN world
  chrome.runtime.onMessage.addListener((message) => {
    window.postMessage(
      { ...message, source: "webmcp-isolated", nonce: NONCE },
      window.location.origin,
    );
  });
})();
