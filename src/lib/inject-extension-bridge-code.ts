import { BRIDGE_CODE_MSG_TYPE } from "@/lib/constants";

/**
 * Send a one-time bridge code to the content script via postMessage.
 *
 * Replaces `injectExtensionToken` (which posted a bearer token directly).
 * The web app posts the code; the content script (isolated world) receives
 * it, validates origin/source/type, then calls
 * `POST /api/extension/token/exchange` directly to swap the code for a
 * bearer token. The bearer token never appears in MAIN-world JS reach.
 *
 * Threat model: any MAIN-world JS can still listen for the postMessage and
 * capture the code, but the code is single-use, short-lived, and bound to
 * the issuing user/tenant. A captured code yields a token only if the
 * attacker wins a race with the legitimate content script's exchange call.
 */
export function injectExtensionBridgeCode(code: string, expiresAt: number): void {
  window.postMessage(
    { type: BRIDGE_CODE_MSG_TYPE, code, expiresAt },
    window.location.origin,
  );
}
