// Content script entry point — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: token-bridge-lib.ts (for tests).
//
// Listens for postMessage from the MAIN world relay script and forwards
// valid token data to the background service worker.

var MSG_TYPE = "PASSWD_SSO_TOKEN_RELAY";

function isContextValid() {
  try { return !!chrome.runtime && !!chrome.runtime.id; }
  catch (e) { return false; }
}

function handlePostMessage(event) {
  // Must come from the same window (not an iframe)
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!event.data || event.data.type !== MSG_TYPE) return;

  var token = event.data.token;
  var expiresAt = event.data.expiresAt;
  if (typeof token !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return;
  }
  if (!isContextValid()) return;

  chrome.runtime.sendMessage({
    type: "SET_TOKEN",
    token: token,
    expiresAt: expiresAt,
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("message", handlePostMessage);
}
