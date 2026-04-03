// MAIN world relay script — plain JS (no TypeScript, no import/export).
// Listens for CustomEvent from the web app and forwards token data
// to the ISOLATED world content script via window.postMessage.
//
// This script runs in the MAIN world (same as the web app's JS).
// The content script (ISOLATED world) validates the postMessage origin
// before forwarding to the background service worker.

(function () {
  var EVENT_NAME = "passwd-sso-token-bridge";
  var MSG_TYPE = "PASSWD_SSO_TOKEN_RELAY";

  document.addEventListener(EVENT_NAME, function (e) {
    var detail = e.detail;
    if (!detail || typeof detail.token !== "string" || typeof detail.expiresAt !== "number") {
      return;
    }
    window.postMessage({
      type: MSG_TYPE,
      token: detail.token,
      expiresAt: detail.expiresAt,
    }, window.location.origin);
  });
})();
