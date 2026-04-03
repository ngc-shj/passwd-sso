import { TOKEN_BRIDGE_MSG_TYPE } from "@/lib/constants";

/**
 * Send the extension token directly to the content script via postMessage.
 *
 * The ISOLATED-world content script receives window.postMessage from the
 * MAIN world (page JS) because they share the same window for messaging.
 * No MAIN-world relay script is needed.
 *
 * The token never appears as a DOM attribute — it exists only as a
 * single postMessage event, reducing the exposure window from 10 seconds
 * (old DOM injection) to a single synchronous call.
 *
 * Threat model note: any MAIN-world JS can listen for postMessage.
 * This is a defense-in-depth improvement, not a complete mitigation.
 * See docs/archive/review/harden-extension-token-bridge-plan.md.
 */
export function injectExtensionToken(token: string, expiresAt: number): void {
  window.postMessage(
    { type: TOKEN_BRIDGE_MSG_TYPE, token, expiresAt },
    window.location.origin,
  );
}
