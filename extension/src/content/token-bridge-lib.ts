import { TOKEN_BRIDGE_MSG_TYPE } from "../lib/constants";

function isContextValid(): boolean {
  try { return !!chrome.runtime?.id; }
  catch { return false; }
}

/**
 * Validate and forward a postMessage token relay to the background script.
 * Returns true if the message was valid and forwarded.
 */
export function handlePostMessage(event: MessageEvent): boolean {
  // Origin validation: must come from the same window (not an iframe)
  if (event.source !== window) return false;
  if (event.origin !== window.location.origin) return false;

  // Type discriminator check
  if (!event.data || event.data.type !== TOKEN_BRIDGE_MSG_TYPE) return false;

  const { token, expiresAt } = event.data;
  if (typeof token !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return false;
  }

  if (!isContextValid()) return false;

  chrome.runtime.sendMessage({
    type: "SET_TOKEN",
    token,
    expiresAt,
  });
  return true;
}

/** Start listening for postMessage relay from the MAIN world relay script. */
export function startPostMessageListener(): void {
  window.addEventListener("message", handlePostMessage);
}
