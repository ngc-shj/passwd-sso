import {
  TOKEN_BRIDGE_MSG_TYPE,
  BRIDGE_CODE_MSG_TYPE,
} from "../lib/constants";
import { EXT_API_PATH } from "../lib/api-paths";

function isContextValid(): boolean {
  try { return !!chrome.runtime?.id; }
  catch { return false; }
}

/** Resolve the configured server URL from extension storage. */
async function getServerUrl(): Promise<string | null> {
  try {
    const { serverUrl } = await chrome.storage.local.get("serverUrl");
    if (typeof serverUrl !== "string" || !serverUrl) return null;
    return serverUrl;
  } catch {
    return null;
  }
}

/** Forward a token to the background service worker. */
function forwardToken(token: string, expiresAtMs: number): void {
  chrome.runtime.sendMessage({
    type: "SET_TOKEN",
    token,
    expiresAt: expiresAtMs,
  });
}

/**
 * Handle a bridge code postMessage: validate, exchange the code for a bearer
 * token via direct fetch, then forward the token to background. Runs in the
 * content script's isolated world — MAIN-world JS cannot intercept the fetch.
 */
async function handleBridgeCodeMessage(event: MessageEvent): Promise<boolean> {
  const { code, expiresAt } = event.data ?? {};
  if (typeof code !== "string" || code.length !== 64) return false;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false;
  if (!isContextValid()) return false;

  const serverUrl = await getServerUrl();
  if (!serverUrl) return false;

  try {
    const response = await fetch(
      `${serverUrl}${EXT_API_PATH.EXTENSION_TOKEN_EXCHANGE}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      },
    );
    if (!response.ok) return false;
    const json = await response.json();
    if (typeof json?.token !== "string" || typeof json?.expiresAt !== "string") {
      return false;
    }
    forwardToken(json.token, Date.parse(json.expiresAt));
    return true;
  } catch {
    return false;
  }
}

/** Handle the legacy token relay postMessage (kept until extension v0.5.x). */
function handleLegacyTokenMessage(event: MessageEvent): boolean {
  const { token, expiresAt } = event.data ?? {};
  if (typeof token !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return false;
  }
  if (!isContextValid()) return false;
  forwardToken(token, expiresAt);
  return true;
}

/**
 * Validate and forward a postMessage from the web app to the background.
 * Supports two message types during migration:
 *   - BRIDGE_CODE_MSG_TYPE (new): code → fetch exchange → forward token
 *   - TOKEN_BRIDGE_MSG_TYPE (legacy): bearer token → forward directly
 *
 * The legacy path is kept until the extension reaches v0.5.x and all
 * users have updated. See plan §Step 11 (deprecation lifecycle).
 *
 * Returns true if the message was valid and processed.
 */
export async function handlePostMessage(event: MessageEvent): Promise<boolean> {
  // Origin validation: must come from the same window (not an iframe)
  if (event.source !== window) return false;
  if (event.origin !== window.location.origin) return false;
  if (!event.data) return false;

  if (event.data.type === BRIDGE_CODE_MSG_TYPE) {
    return handleBridgeCodeMessage(event);
  }

  if (event.data.type === TOKEN_BRIDGE_MSG_TYPE) {
    // TODO: remove after web app + extension reach v0.5.x and telemetry
    // shows zero legacy traffic for 30 days.
    return handleLegacyTokenMessage(event);
  }

  return false;
}

/** Start listening for postMessage relay from the MAIN world relay script. */
export function startPostMessageListener(): void {
  window.addEventListener("message", (event) => {
    void handlePostMessage(event);
  });
}
