import {
  BRIDGE_CODE_MSG_TYPE,
  BRIDGE_CODE_LENGTH,
  EXT_JKT_REQUEST_MSG_TYPE,
  EXT_JKT_READY_MSG_TYPE,
} from "../lib/constants";
import { EXT_API_PATH } from "../lib/api-paths";

// Mirror of server-side Zod schema in src/app/api/extension/token/exchange/route.ts
const BRIDGE_CODE_RE = new RegExp(`^[a-f0-9]{${BRIDGE_CODE_LENGTH}}$`);

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

/** Ask the background SW for the current DPoP JKT. */
async function getJktFromBackground(): Promise<string | null> {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_DPOP_JKT" }) as { jkt: string | null };
    if (typeof res?.jkt === "string" && /^[A-Za-z0-9_-]{43}$/.test(res.jkt)) {
      return res.jkt;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ask the background SW to sign a DPoP proof. */
async function getDpopProofFromBackground(route: string, method: string): Promise<string | null> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "GET_DPOP_PROOF",
      route,
      method,
    }) as { dpop: string | null };
    return typeof res?.dpop === "string" ? res.dpop : null;
  } catch {
    return null;
  }
}

/** Forward a token to the background service worker. */
function forwardToken(token: string, expiresAtMs: number, cnfJkt: string): void {
  chrome.runtime.sendMessage({
    type: "SET_TOKEN",
    token,
    expiresAt: expiresAtMs,
    cnfJkt,
  });
}

/**
 * Handle a JKT request postMessage from the web app:
 * ask the background for the DPoP thumbprint and post back READY.
 */
async function handleJktRequestMessage(event: MessageEvent): Promise<boolean> {
  const { reqId } = event.data ?? {};
  if (typeof reqId !== "string") return false;
  if (!isContextValid()) return false;

  const jkt = await getJktFromBackground();
  if (!jkt) return false;

  window.postMessage(
    { type: EXT_JKT_READY_MSG_TYPE, reqId, jkt },
    window.location.origin,
  );
  return true;
}

/**
 * Handle a bridge code postMessage: validate, request a DPoP proof from
 * background, exchange the code for a bearer token via direct fetch with
 * DPoP header, then forward the token to background. Runs in the content
 * script's isolated world — MAIN-world JS cannot intercept the fetch.
 */
async function handleBridgeCodeMessage(event: MessageEvent): Promise<boolean> {
  const { code, expiresAt } = event.data ?? {};
  if (typeof code !== "string" || !BRIDGE_CODE_RE.test(code)) return false;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false;
  if (!isContextValid()) return false;

  const serverUrl = await getServerUrl();
  if (!serverUrl) return false;

  const dpopProof = await getDpopProofFromBackground(
    EXT_API_PATH.EXTENSION_TOKEN_EXCHANGE,
    "POST",
  );

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (dpopProof) {
    headers["DPoP"] = dpopProof;
  }

  try {
    const response = await fetch(
      `${serverUrl}${EXT_API_PATH.EXTENSION_TOKEN_EXCHANGE}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ code }),
      },
    );
    if (!response.ok) return false;
    const json = await response.json();
    if (typeof json?.token !== "string" || typeof json?.expiresAt !== "string") {
      return false;
    }
    if (typeof json?.cnfJkt !== "string") {
      return false;
    }
    forwardToken(json.token, Date.parse(json.expiresAt), json.cnfJkt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and forward a postMessage from the web app to the background.
 * Accepts:
 *   - EXT_JKT_REQUEST_MSG_TYPE: web app requests the extension's DPoP thumbprint
 *   - BRIDGE_CODE_MSG_TYPE: web app posts a one-time code; content script
 *     exchanges it (with DPoP) for a bearer token, then forwards to background.
 *
 * Returns true if the message was valid and processed.
 */
export async function handlePostMessage(event: MessageEvent): Promise<boolean> {
  // Origin validation: must come from the same window (not an iframe)
  if (event.source !== window) return false;
  if (event.origin !== window.location.origin) return false;
  if (!event.data) return false;

  if (event.data.type === EXT_JKT_REQUEST_MSG_TYPE) {
    return handleJktRequestMessage(event);
  }

  if (event.data.type === BRIDGE_CODE_MSG_TYPE) {
    return handleBridgeCodeMessage(event);
  }

  return false;
}

/** Start listening for postMessage relay from the MAIN world relay script. */
export function startPostMessageListener(): void {
  window.addEventListener("message", (event) => {
    void handlePostMessage(event);
  });
}
