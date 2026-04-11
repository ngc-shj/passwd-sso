// ── Token bridge (shared contract with extension's token-bridge content script) ──
/** @deprecated Use TOKEN_BRIDGE_EVENT for new code. Kept for reference only. */
export const TOKEN_ELEMENT_ID = "passwd-sso-ext-token";
export const TOKEN_READY_EVENT = "passwd-sso-token-ready";

// New token bridge: postMessage (web app) → content script (ISOLATED world)
export const TOKEN_BRIDGE_MSG_TYPE = "PASSWD_SSO_TOKEN_RELAY";

// Bridge code flow: postMessage (web app) → content script → exchange endpoint
// Replaces TOKEN_BRIDGE_MSG_TYPE for new clients. Web app posts a one-time code
// instead of a bearer token; the extension exchanges it for a token via direct fetch.
export const BRIDGE_CODE_MSG_TYPE = "PASSWD_SSO_BRIDGE_CODE";

// Bridge code TTL — short enough to limit replay window, long enough to survive
// extension wakeup latency on slow devices.
export const BRIDGE_CODE_TTL_MS = 60 * 1000; // 60 seconds

// Maximum unused bridge codes per user (oldest auto-revoked when exceeded).
export const BRIDGE_CODE_MAX_ACTIVE = 3;

// ── URL params ──
export const EXT_CONNECT_PARAM = "ext_connect";
