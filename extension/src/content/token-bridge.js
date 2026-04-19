// Content script entry point — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: token-bridge-lib.ts (for tests).
//
// Accepts a single message type:
//   - PASSWD_SSO_BRIDGE_CODE: receives a one-time code, exchanges it for a
//     token via direct fetch to /api/extension/token/exchange, then forwards
//     the token to background via chrome.runtime.sendMessage.
//
// Constants (must stay in sync with extension/src/lib/constants.ts +
// src/lib/constants/extension.ts on the web app side). The sync test
// src/__tests__/i18n/extension-constants-sync.test.ts enforces this.

var BRIDGE_CODE_MSG_TYPE = "PASSWD_SSO_BRIDGE_CODE";
var EXCHANGE_PATH = "/api/extension/token/exchange";

function isContextValid() {
  try { return !!chrome.runtime && !!chrome.runtime.id; }
  catch (e) { return false; }
}

function getServerUrl() {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get("serverUrl", function (result) {
        var serverUrl = result && result.serverUrl;
        if (typeof serverUrl !== "string" || !serverUrl) {
          resolve(null);
          return;
        }
        resolve(serverUrl);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function forwardToken(token, expiresAtMs) {
  chrome.runtime.sendMessage({
    type: "SET_TOKEN",
    token: token,
    expiresAt: expiresAtMs,
  });
}

function handleBridgeCodeMessage(event) {
  var code = event.data.code;
  var expiresAt = event.data.expiresAt;
  if (typeof code !== "string" || code.length !== 64) return;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return;
  if (!isContextValid()) return;

  getServerUrl().then(function (serverUrl) {
    if (!serverUrl) return;
    fetch(serverUrl + EXCHANGE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code }),
    }).then(function (response) {
      if (!response.ok) return;
      return response.json();
    }).then(function (json) {
      if (!json) return;
      var token = json.token;
      var expiresAtIso = json.expiresAt;
      if (typeof token !== "string" || typeof expiresAtIso !== "string") return;
      var parsed = Date.parse(expiresAtIso);
      if (!Number.isFinite(parsed)) return;
      forwardToken(token, parsed);
    }).catch(function () {
      // network / parse error — swallow, extension stays unconnected
    });
  });
}

function handlePostMessage(event) {
  // Must come from the same window (not an iframe)
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!event.data) return;

  if (event.data.type === BRIDGE_CODE_MSG_TYPE) {
    handleBridgeCodeMessage(event);
    return;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("message", handlePostMessage);
}
