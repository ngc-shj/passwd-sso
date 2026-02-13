// Shadow DOM host management for content script UI.
// Uses closed shadow root to isolate styles from the host page.

let shadowHost: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;

export function getShadowHost(): { host: HTMLDivElement; root: ShadowRoot } {
  if (shadowHost && shadowRoot && document.body.contains(shadowHost)) {
    return { host: shadowHost, root: shadowRoot };
  }
  // Clean up stale host
  removeShadowHost();

  const host = document.createElement("div");
  host.id = "passwd-sso-shadow-host";
  host.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });

  document.body.appendChild(host);
  shadowHost = host;
  shadowRoot = root;
  return { host, root };
}

export function removeShadowHost(): void {
  if (shadowHost) {
    shadowHost.remove();
    shadowHost = null;
    shadowRoot = null;
  }
}
