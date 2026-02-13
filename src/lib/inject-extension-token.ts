import { TOKEN_ELEMENT_ID, TOKEN_READY_EVENT } from "@/lib/constants";

/**
 * Inject an extension token into the DOM for the token-bridge content script to pick up.
 * The element is auto-removed after 10 seconds.
 */
export function injectExtensionToken(token: string, expiresAt: number): void {
  const existing = document.getElementById(TOKEN_ELEMENT_ID);
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = TOKEN_ELEMENT_ID;
  el.setAttribute("data-token", token);
  el.setAttribute("data-expires-at", String(expiresAt));
  el.style.display = "none";
  document.body.appendChild(el);
  // Notify token-bridge even if its MutationObserver has timed out
  document.dispatchEvent(new CustomEvent(TOKEN_READY_EVENT));
  setTimeout(() => {
    el.remove();
  }, 10_000);
}
