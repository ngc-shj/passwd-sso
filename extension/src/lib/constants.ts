// ── Token bridge (legacy DOM-event constants kept for backwards-compatibility) ──
/** @deprecated Kept for reference only; no current code path emits this event. */
export const TOKEN_ELEMENT_ID = "passwd-sso-ext-token";
export const TOKEN_READY_EVENT = "passwd-sso-token-ready";

// Extension-connect handshake (web app → content script → SW → server).
// The web app posts EXT_CONNECT_REQUEST after sign-in to ask the extension to
// initiate the bridge-code + exchange flow. The SW posts EXT_CONNECT_READY
// back via the content script once the flow completes (success or failure).
// Mirror values in src/lib/constants/integrations/extension.ts; the sync test enforces equality.
export const EXT_CONNECT_REQUEST_MSG_TYPE = "PASSWD_SSO_EXT_CONNECT_REQUEST";
export const EXT_CONNECT_READY_MSG_TYPE = "PASSWD_SSO_EXT_CONNECT_READY";

// Bridge code wire constants (mirror of web app constant — sync test enforces equality)
export const BRIDGE_CODE_TTL_MS = 60 * 1000;
export const BRIDGE_CODE_MAX_ACTIVE = 3;
export const BRIDGE_CODE_LENGTH = 64;

/** RFC 7638 §3 thumbprint is always 43 base64url characters. */
export const JKT_RE = /^[A-Za-z0-9_-]{43}$/;

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
  // Web app → content script → SW: initiate the bridge-code → exchange flow.
  // The SW signs DPoP + fetches /api/extension/bridge-code (credentialed) +
  // /api/extension/token/exchange + persists the resulting token.
  START_CONNECT: "START_CONNECT",
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
  // Options → SW: invalidate the SW's in-memory DPoP key cache after the
  // Options page deleted the IDB record. Without this the SW keeps signing
  // bridge-code DPoP proofs with the stale key, producing tokens that the
  // next reset cannot revoke (cnf_jkt mismatch on /key/reset DPoP verify).
  RESET_DPOP_KEY: "RESET_DPOP_KEY",
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
