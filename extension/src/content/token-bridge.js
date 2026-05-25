// Content script entry point — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: token-bridge-lib.ts (for tests).
//
// C7 — Connect handshake relay. The content script's only role is to receive
// EXT_CONNECT_REQUEST postMessages from the web app, forward them to the SW
// via the START_CONNECT runtime message, and post EXT_CONNECT_READY back to
// the web app with the SW's {ok, errorCode}. The content script NEVER sees
// the bridge code, the bearer token, or any DPoP key material.
//
// Constants (must stay in sync with extension/src/lib/constants.ts +
// src/lib/constants/integrations/extension.ts on the web app side). The sync test
// src/__tests__/i18n/extension-constants-sync.test.ts enforces this.

var EXT_CONNECT_REQUEST_MSG_TYPE = "PASSWD_SSO_EXT_CONNECT_REQUEST";
var EXT_CONNECT_READY_MSG_TYPE = "PASSWD_SSO_EXT_CONNECT_READY";
var START_CONNECT_MSG = "START_CONNECT";

function isContextValid() {
  try {
    return !!chrome.runtime && !!chrome.runtime.id;
  } catch (e) {
    return false;
  }
}

function postReady(reqId, ok, errorCode) {
  var message = { type: EXT_CONNECT_READY_MSG_TYPE, reqId: reqId, ok: ok };
  if (errorCode) message.errorCode = errorCode;
  window.postMessage(message, window.location.origin);
}

function handleConnectRequestMessage(event) {
  var reqId = event.data && event.data.reqId;
  if (typeof reqId !== "string" || reqId.length === 0) return;
  if (!isContextValid()) {
    postReady(reqId, false, "EXTENSION_ABSENT");
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: START_CONNECT_MSG }, function (response) {
      if (chrome.runtime.lastError) {
        postReady(reqId, false, "GENERIC_FAILURE");
        return;
      }
      if (!response) {
        postReady(reqId, false, "GENERIC_FAILURE");
        return;
      }
      postReady(reqId, response.ok === true, response.errorCode);
    });
  } catch (e) {
    postReady(reqId, false, "GENERIC_FAILURE");
  }
}

function handlePostMessage(event) {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!event.data) return;

  if (event.data.type === EXT_CONNECT_REQUEST_MSG_TYPE) {
    handleConnectRequestMessage(event);
    return;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("message", handlePostMessage);
}
