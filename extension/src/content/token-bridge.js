// Content script entry point — plain JS (no TypeScript, no import/export).
// CRXJS copies web_accessible_resources as-is without transpilation.
// Typed version: token-bridge-lib.ts (for tests).

function isContextValid() {
  try { return !!chrome.runtime && !!chrome.runtime.id; }
  catch (e) { return false; }
}

function tryReadToken() {
  var el = document.getElementById("passwd-sso-ext-token");
  if (!el) return false;
  if (!isContextValid()) return false;
  var token = el.getAttribute("data-token");
  var expiresAtRaw = el.getAttribute("data-expires-at");
  var expiresAt = expiresAtRaw ? Number(expiresAtRaw) : NaN;
  if (!token || !Number.isFinite(expiresAt)) {
    el.remove();
    return false;
  }
  chrome.runtime.sendMessage({
    type: "SET_TOKEN",
    token: token,
    expiresAt: expiresAt,
  });
  el.remove();
  return true;
}

function startObserver() {
  if (!document || !document.body) return;
  var observer = new MutationObserver(function () {
    if (tryReadToken()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(function () { observer.disconnect(); }, 30000);
}

if (typeof document !== "undefined") {
  if (!tryReadToken()) {
    startObserver();
  }
}
