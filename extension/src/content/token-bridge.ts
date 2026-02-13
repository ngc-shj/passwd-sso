// Content script entry point — NO import/export allowed.
// Chrome content scripts run as non-modules; CRXJS does not bundle
// web_accessible_resources files. Logic is duplicated in
// token-bridge-lib.ts (with export) for testability.

function tryReadToken(): boolean {
  const el = document.getElementById("passwd-sso-ext-token");
  if (!el) return false;
  const token = el.getAttribute("data-token");
  const expiresAtRaw = el.getAttribute("data-expires-at");
  const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : NaN;
  if (!token || !Number.isFinite(expiresAt)) {
    el.remove();
    return false;
  }
  chrome.runtime.sendMessage({
    type: "SET_TOKEN",
    token,
    expiresAt,
  });
  el.remove();
  return true;
}

function startObserver(): void {
  if (!document?.body) return;
  const observer = new MutationObserver(() => {
    if (tryReadToken()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30_000);
}

if (typeof document !== "undefined") {
  if (!tryReadToken()) {
    startObserver();
  }
}
