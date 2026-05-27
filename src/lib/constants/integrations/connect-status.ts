export const CONNECT_STATUS = {
  IDLE: "idle",
  // PROTOTYPE C15-v2: shown when ?ext_connect=1 is present but user has not
  // yet clicked Connect. Click-driven flow replaces auto-fire so that the
  // postMessage carries a real user activation (programmatic .click() does
  // not set userActivation per spec — XSS cannot forge it).
  AWAITING_CLICK: "awaiting_click",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  FAILED: "failed",
} as const;

export type ConnectStatus =
  (typeof CONNECT_STATUS)[keyof typeof CONNECT_STATUS];
