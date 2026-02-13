// ── Token bridge (shared contract with web app's inject-extension-token.ts) ──
export const TOKEN_ELEMENT_ID = "passwd-sso-ext-token";
export const TOKEN_READY_EVENT = "passwd-sso-token-ready";

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

// ── URL params ──
export const EXT_CONNECT_PARAM = "ext_connect";

// ── Entry types used in extension UI/logic ──
export const EXT_ENTRY_TYPE = {
  LOGIN: "LOGIN",
} as const;
