// Content script entry point — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: token-bridge-lib.ts (for tests).
//
// Accepts these message types:
//   - PASSWD_SSO_EXT_JKT_REQUEST: web app requests the extension's DPoP thumbprint.
//   - PASSWD_SSO_BRIDGE_CODE: receives a one-time code, obtains a DPoP proof,
//     exchanges it for a token via direct fetch, then forwards to background.
//
// Constants (must stay in sync with extension/src/lib/constants.ts +
// src/lib/constants/integrations/extension.ts on the web app side). The sync test
// src/__tests__/i18n/extension-constants-sync.test.ts enforces this.

var BRIDGE_CODE_MSG_TYPE = "PASSWD_SSO_BRIDGE_CODE";
var EXT_JKT_REQUEST_MSG_TYPE = "PASSWD_SSO_EXT_JKT_REQUEST";
var EXT_JKT_READY_MSG_TYPE = "PASSWD_SSO_EXT_JKT_READY";
var BRIDGE_CODE_LENGTH = 64;
var BRIDGE_CODE_RE = new RegExp("^[a-f0-9]{" + BRIDGE_CODE_LENGTH + "}$");
var EXCHANGE_PATH = "/api/extension/token/exchange";
var JKT_RE = /^[A-Za-z0-9_-]{43}$/; // Mirror of JKT_RE in extension/src/lib/constants.ts

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

function getJktFromBackground() {
  return new Promise(function (resolve) {
    try {
      chrome.runtime.sendMessage({ type: "GET_DPOP_JKT" }, function (res) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        if (res && typeof res.jkt === "string" && JKT_RE.test(res.jkt)) {
          resolve(res.jkt);
        } else {
          resolve(null);
        }
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function getDpopProofFromBackground(route, method) {
  return new Promise(function (resolve) {
    try {
      chrome.runtime.sendMessage({ type: "GET_DPOP_PROOF", route: route, method: method }, function (res) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((res && typeof res.dpop === "string") ? res.dpop : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function forwardToken(token, expiresAtMs, cnfJkt) {
  chrome.runtime.sendMessage({
    type: "SET_TOKEN",
    token: token,
    expiresAt: expiresAtMs,
    cnfJkt: cnfJkt,
  });
}

function handleJktRequestMessage(event) {
  var reqId = event.data && event.data.reqId;
  if (typeof reqId !== "string") return;
  if (!isContextValid()) return;

  getJktFromBackground().then(function (jkt) {
    if (!jkt) return;
    window.postMessage(
      { type: EXT_JKT_READY_MSG_TYPE, reqId: reqId, jkt: jkt },
      window.location.origin
    );
  });
}

function handleBridgeCodeMessage(event) {
  var code = event.data.code;
  var expiresAt = event.data.expiresAt;
  if (typeof code !== "string" || !BRIDGE_CODE_RE.test(code)) return;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return;
  if (!isContextValid()) return;

  getServerUrl().then(function (serverUrl) {
    if (!serverUrl) return;

    getDpopProofFromBackground(EXCHANGE_PATH, "POST").then(function (dpopProof) {
      // DPoP proof is required; without it the server will reject the exchange.
      if (!dpopProof) return;

      var headers = { "Content-Type": "application/json", "DPoP": dpopProof };

      fetch(serverUrl + EXCHANGE_PATH, {
        method: "POST",
        // Omit cookies — extension auth is Bearer + DPoP. Cookies would
        // trip the server's CSRF gate (cookie+POST → assertOrigin rejects
        // chrome-extension origin with 403). Content script runs in page
        // context, so default credentials would attach web app cookies.
        credentials: "omit",
        headers: headers,
        body: JSON.stringify({ code: code }),
      }).then(function (response) {
        if (!response.ok) return;
        return response.json();
      }).then(function (json) {
        if (!json) return;
        var token = json.token;
        var expiresAtIso = json.expiresAt;
        var cnfJkt = json.cnfJkt;
        if (typeof token !== "string" || typeof expiresAtIso !== "string") return;
        if (typeof cnfJkt !== "string") return;
        var parsed = Date.parse(expiresAtIso);
        if (!Number.isFinite(parsed)) return;
        forwardToken(token, parsed, cnfJkt);
      }).catch(function () {
        // network / parse error — swallow, extension stays unconnected
      });
    });
  });
}

function handlePostMessage(event) {
  // Must come from the same window (not an iframe)
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!event.data) return;

  if (event.data.type === EXT_JKT_REQUEST_MSG_TYPE) {
    handleJktRequestMessage(event);
    return;
  }

  if (event.data.type === BRIDGE_CODE_MSG_TYPE) {
    handleBridgeCodeMessage(event);
    return;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("message", handlePostMessage);
}
