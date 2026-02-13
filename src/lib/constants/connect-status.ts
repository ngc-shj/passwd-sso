export const EXT_CONNECT_PARAM = "ext_connect";

export const CONNECT_STATUS = {
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  FAILED: "failed",
} as const;

export type ConnectStatus =
  (typeof CONNECT_STATUS)[keyof typeof CONNECT_STATUS];
