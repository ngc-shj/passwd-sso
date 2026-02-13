/**
 * Inject an extension token into the DOM for the token-bridge content script to pick up.
 * The element is auto-removed after 10 seconds.
 */
export function injectExtensionToken(token: string, expiresAt: number): void {
  const existing = document.getElementById("passwd-sso-ext-token");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = "passwd-sso-ext-token";
  el.setAttribute("data-token", token);
  el.setAttribute("data-expires-at", String(expiresAt));
  el.style.display = "none";
  document.body.appendChild(el);
  // Notify token-bridge even if its MutationObserver has timed out
  document.dispatchEvent(new CustomEvent("passwd-sso-token-ready"));
  setTimeout(() => {
    el.remove();
  }, 10_000);
}
