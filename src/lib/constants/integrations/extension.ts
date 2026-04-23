import { MS_PER_MINUTE } from "../time";

// ── Token bridge (shared contract with extension's token-bridge content script) ──
/** @deprecated Use TOKEN_BRIDGE_EVENT for new code. Kept for reference only. */
export const TOKEN_ELEMENT_ID = "passwd-sso-ext-token";
export const TOKEN_READY_EVENT = "passwd-sso-token-ready";

// Bridge code flow: postMessage (web app) → content script → exchange endpoint.
// The web app posts a one-time code; the extension exchanges it for a bearer
// token via direct fetch in the content script's isolated world.
export const BRIDGE_CODE_MSG_TYPE = "PASSWD_SSO_BRIDGE_CODE";

// Bridge code TTL — short enough to limit replay window, long enough to survive
// extension wakeup latency on slow devices.
export const BRIDGE_CODE_TTL_MS = MS_PER_MINUTE; // 60 seconds

// Maximum unused bridge codes per user (oldest auto-revoked when exceeded).
export const BRIDGE_CODE_MAX_ACTIVE = 3;

// ── URL params ──
export const EXT_CONNECT_PARAM = "ext_connect";
