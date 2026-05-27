export const CONNECT_STATUS = {
  IDLE: "idle",
  // Shown after `?ext_connect=1` is detected on the page but before the user
  // has confirmed via the Allow button. The click satisfies
  // navigator.userActivation.isActive at the moment of window.postMessage,
  // which the extension content script requires (C15-v2 gate). Programmatic
  // `.click()` does NOT set userActivation per HTML User Activation v2, so
  // XSS in the host page cannot reach this state's downstream postMessage.
  AWAITING_CLICK: "awaiting_click",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  FAILED: "failed",
} as const;

export type ConnectStatus =
  (typeof CONNECT_STATUS)[keyof typeof CONNECT_STATUS];
