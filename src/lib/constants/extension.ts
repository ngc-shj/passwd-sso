// ── Token bridge (shared contract with extension's token-bridge content script) ──
/** @deprecated Use TOKEN_BRIDGE_EVENT for new code. Kept for reference only. */
export const TOKEN_ELEMENT_ID = "passwd-sso-ext-token";
export const TOKEN_READY_EVENT = "passwd-sso-token-ready";

// New token bridge: postMessage (web app) → content script (ISOLATED world)
export const TOKEN_BRIDGE_MSG_TYPE = "PASSWD_SSO_TOKEN_RELAY";

// ── URL params ──
export const EXT_CONNECT_PARAM = "ext_connect";
