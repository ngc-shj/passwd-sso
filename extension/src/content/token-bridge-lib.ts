// Production mirror: extension/src/content/token-bridge.js (plain JS, no imports).
// All logic changes here MUST be applied symmetrically to token-bridge.js.
//
// C7 — Connect handshake. The content script's role narrowed to a pure relay:
// it receives EXT_CONNECT_REQUEST from the web app, forwards it to the SW via
// EXT_MSG.START_CONNECT, and posts back EXT_CONNECT_READY with the SW's
// {ok, errorCode}. The content script NEVER sees the bridge code, the bearer
// token, or any DPoP key material — those stay inside the SW's heap.
import {
  EXT_CONNECT_REQUEST_MSG_TYPE,
  EXT_CONNECT_READY_MSG_TYPE,
  EXT_MSG,
} from "../lib/constants";

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

interface ConnectReadyEnvelope {
  type: typeof EXT_CONNECT_READY_MSG_TYPE;
  reqId: string;
  ok: boolean;
  errorCode?: string;
}

function postReady(reqId: string, ok: boolean, errorCode?: string): void {
  const message: ConnectReadyEnvelope = {
    type: EXT_CONNECT_READY_MSG_TYPE,
    reqId,
    ok,
    ...(errorCode ? { errorCode } : {}),
  };
  window.postMessage(message, window.location.origin);
}

/**
 * Handle an EXT_CONNECT_REQUEST postMessage: forward to SW and relay the
 * SW's response back to the web app.
 *
 * Returns true if the message was valid and processed (success or failure).
 */
async function handleConnectRequestMessage(event: MessageEvent): Promise<boolean> {
  const { reqId } = (event.data ?? {}) as { reqId?: unknown };
  if (typeof reqId !== "string" || reqId.length === 0) return false;
  if (!isContextValid()) {
    postReady(reqId, false, "EXTENSION_ABSENT");
    return true;
  }

  try {
    const response = (await chrome.runtime.sendMessage({
      type: EXT_MSG.START_CONNECT,
    })) as { ok?: boolean; errorCode?: string } | undefined;

    if (!response) {
      postReady(reqId, false, "GENERIC_FAILURE");
      return true;
    }
    postReady(reqId, response.ok === true, response.errorCode);
    return true;
  } catch {
    postReady(reqId, false, "GENERIC_FAILURE");
    return true;
  }
}

/**
 * Validate and dispatch a postMessage from the web app. The content script
 * only listens for EXT_CONNECT_REQUEST — every other shape is ignored.
 *
 * Returns true if the message was valid and processed.
 */
export async function handlePostMessage(event: MessageEvent): Promise<boolean> {
  if (event.source !== window) return false;
  if (event.origin !== window.location.origin) return false;
  if (!event.data) return false;

  if (event.data.type === EXT_CONNECT_REQUEST_MSG_TYPE) {
    return handleConnectRequestMessage(event);
  }
  return false;
}

/** Start listening for postMessage relay from the MAIN world relay script. */
export function startPostMessageListener(): void {
  window.addEventListener("message", (event) => {
    void handlePostMessage(event);
  });
}
