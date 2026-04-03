import { TOKEN_BRIDGE_EVENT } from "@/lib/constants";

/**
 * Dispatch a CustomEvent containing the extension token for the MAIN-world
 * relay script to forward via postMessage to the content script.
 *
 * The token never appears as a DOM attribute — it exists only as a
 * synchronous event detail, reducing the exposure window from 10 seconds
 * (old DOM injection) to a single event dispatch cycle.
 *
 * Threat model note: any MAIN-world JS can listen for this event.
 * This is a defense-in-depth improvement, not a complete mitigation.
 * See docs/archive/review/harden-extension-token-bridge-plan.md.
 */
export function injectExtensionToken(token: string, expiresAt: number): void {
  document.dispatchEvent(
    new CustomEvent(TOKEN_BRIDGE_EVENT, {
      detail: { token, expiresAt },
    }),
  );
}
