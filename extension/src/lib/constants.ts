// ── Token bridge (shared contract with web app's inject-extension-token.ts) ──
/** @deprecated Use TOKEN_BRIDGE_EVENT for new code. */
export const TOKEN_ELEMENT_ID = "passwd-sso-ext-token";
export const TOKEN_READY_EVENT = "passwd-sso-token-ready";

// New token bridge: postMessage (web app) → content script (ISOLATED world)
export const TOKEN_BRIDGE_MSG_TYPE = "PASSWD_SSO_TOKEN_RELAY";

// Bridge code flow: postMessage (web app) → content script → exchange endpoint.
// Mirror values in src/lib/constants/extension.ts (web app side); a sync test
// validates equality between the two repos.
export const BRIDGE_CODE_MSG_TYPE = "PASSWD_SSO_BRIDGE_CODE";
export const BRIDGE_CODE_TTL_MS = 60 * 1000;
export const BRIDGE_CODE_MAX_ACTIVE = 3;

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
  PASSKEY: "PASSKEY",
} as const;

// ── WebAuthn bridge (MAIN world ↔ content script) ──
export const WEBAUTHN_BRIDGE_MSG = "PASSWD_SSO_WEBAUTHN";
export const WEBAUTHN_BRIDGE_RESP = "PASSWD_SSO_WEBAUTHN_RESP";

// ── Extension ↔ Service Worker message types ──
export const EXT_MSG = {
  SET_TOKEN: "SET_TOKEN",
  GET_TOKEN: "GET_TOKEN",
  CLEAR_TOKEN: "CLEAR_TOKEN",
  GET_STATUS: "GET_STATUS",
  UNLOCK_VAULT: "UNLOCK_VAULT",
  LOCK_VAULT: "LOCK_VAULT",
  FETCH_PASSWORDS: "FETCH_PASSWORDS",
  COPY_PASSWORD: "COPY_PASSWORD",
  AUTOFILL: "AUTOFILL",
  GET_MATCHES_FOR_URL: "GET_MATCHES_FOR_URL",
  COPY_TOTP: "COPY_TOTP",
  AUTOFILL_FROM_CONTENT: "AUTOFILL_FROM_CONTENT",
  LOGIN_DETECTED: "LOGIN_DETECTED",
  SAVE_LOGIN: "SAVE_LOGIN",
  UPDATE_LOGIN: "UPDATE_LOGIN",
  DISMISS_SAVE_PROMPT: "DISMISS_SAVE_PROMPT",
  CHECK_PENDING_SAVE: "CHECK_PENDING_SAVE",
  AUTOFILL_CREDIT_CARD: "AUTOFILL_CREDIT_CARD",
  AUTOFILL_IDENTITY: "AUTOFILL_IDENTITY",
  KEEPALIVE_PING: "KEEPALIVE_PING",
  // Passkey SW message types (content script → Service Worker)
  PASSKEY_GET_MATCHES: "PASSKEY_GET_MATCHES",
  PASSKEY_SIGN_ASSERTION: "PASSKEY_SIGN_ASSERTION",
  PASSKEY_CHECK_DUPLICATE: "PASSKEY_CHECK_DUPLICATE",
  PASSKEY_CREATE_CREDENTIAL: "PASSKEY_CREATE_CREDENTIAL",
} as const;

// ── WebAuthn clientDataJSON type strings ──
// Note: webauthn-interceptor.js (MAIN world, plain JS) cannot import from this module.
// It declares matching local vars at the top of the IIFE — keep both in sync.
export const WEBAUTHN_TYPE_GET = "webauthn.get";
export const WEBAUTHN_TYPE_CREATE = "webauthn.create";

// ── Passkey bridge action names (MAIN world → content script via postMessage) ──
export const PASSKEY_BRIDGE_ACTION = {
  GET_MATCHES: "PASSKEY_GET_MATCHES",
  SELECT: "PASSKEY_SELECT",
  SIGN_ASSERTION: "PASSKEY_SIGN_ASSERTION",
  CONFIRM_CREATE: "PASSKEY_CONFIRM_CREATE",
  CREATE_CREDENTIAL: "PASSKEY_CREATE_CREDENTIAL",
} as const;
