function isContextValid(): boolean {
  try { return !!chrome.runtime?.id; }
  catch { return false; }
}

export function tryReadToken(): boolean {
  const el = document.getElementById("passwd-sso-ext-token");
  if (!el) return false;
  if (!isContextValid()) return false;
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

export function startObserver(): void {
  if (!document?.body) return;
  const observer = new MutationObserver(() => {
    if (tryReadToken()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30_000);
}
