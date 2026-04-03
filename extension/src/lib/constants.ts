// ── Token bridge (shared contract with web app's inject-extension-token.ts) ──
/** @deprecated Use TOKEN_BRIDGE_EVENT for new code. */
export const TOKEN_ELEMENT_ID = "passwd-sso-ext-token";
export const TOKEN_READY_EVENT = "passwd-sso-token-ready";

// New token bridge: CustomEvent (web app) → postMessage relay (MAIN world) → content script (ISOLATED world)
export const TOKEN_BRIDGE_EVENT = "passwd-sso-token-bridge";
export const TOKEN_BRIDGE_MSG_TYPE = "PASSWD_SSO_TOKEN_RELAY";

// ── Session storage ──
export const SESSION_KEY = "authState";

// ── Alarms ──
export const ALARM_TOKEN_TTL = "extension-token-ttl";
export const ALARM_VAULT_LOCK = "vault-auto-lock";
export const ALARM_TOKEN_REFRESH = "extension-token-refresh";

// ── Scripting ──
export const TOKEN_BRIDGE_SCRIPT_ID = "token-bridge";

// ── Commands ──
export const CMD_TRIGGER_AUTOFILL = "trigger-autofill";
export const CMD_COPY_PASSWORD = "copy-password";
export const CMD_COPY_USERNAME = "copy-username";
export const CMD_LOCK_VAULT = "lock-vault";

// ── Alarms (clipboard) ──
export const ALARM_CLEAR_CLIPBOARD = "clear-clipboard";

// ── URL params ──
export const EXT_CONNECT_PARAM = "ext_connect";

// ── Entry types used in extension UI/logic ──
export const EXT_ENTRY_TYPE = {
  LOGIN: "LOGIN",
  CREDIT_CARD: "CREDIT_CARD",
  IDENTITY: "IDENTITY",
} as const;
