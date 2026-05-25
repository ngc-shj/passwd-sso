import { MS_PER_MINUTE } from "../time";

// ── Token bridge (shared contract with extension's token-bridge content script) ──
/** @deprecated Use TOKEN_BRIDGE_EVENT for new code. Kept for reference only. */
export const TOKEN_ELEMENT_ID = "passwd-sso-ext-token";
export const TOKEN_READY_EVENT = "passwd-sso-token-ready";

// Extension-connect handshake (web app → content script → SW → server).
// After sign-in the web app posts EXT_CONNECT_REQUEST asking the extension's
// SW to initiate the bridge-code + exchange flow. The SW signs DPoP, calls
// the credentialed bridge-code endpoint, exchanges the code for a token, and
// posts EXT_CONNECT_READY back via the content script. The web app never
// sees the bridge code or the token — those stay inside the SW's heap.
// Mirrored to `extension/src/lib/constants.ts`; the sync test enforces equality.
export const EXT_CONNECT_REQUEST_MSG_TYPE = "PASSWD_SSO_EXT_CONNECT_REQUEST";
export const EXT_CONNECT_READY_MSG_TYPE = "PASSWD_SSO_EXT_CONNECT_READY";

// Bridge code TTL — short enough to limit replay window, long enough to survive
// extension wakeup latency on slow devices.
export const BRIDGE_CODE_TTL_MS = MS_PER_MINUTE; // 60 seconds

// Maximum unused bridge codes per user (oldest auto-revoked when exceeded).
export const BRIDGE_CODE_MAX_ACTIVE = 3;

// Bridge code wire format: 64 hex chars (32 random bytes → hex-encoded by
// generateShareToken). Length and character set are validated symmetrically
// on the server (Zod schema in exchange/route.ts) and on the extension
// content script. Mirrored to `extension/src/lib/constants.ts`; the sync
// test at `src/__tests__/i18n/extension-constants-sync.test.ts` enforces
// equality.
export const BRIDGE_CODE_LENGTH = 64;

// ── URL params ──
export const EXT_CONNECT_PARAM = "ext_connect";
