import { API_ERROR } from "@/lib/http/api-error-codes";

// Codes the proxy returns before any API route runs (src/lib/proxy/api-route.ts
// session gate, src/lib/auth/session/csrf.ts), so they prove a POST wrote
// nothing.
export const PROXY_PRE_ROUTE_REFUSALS = [
  API_ERROR.UNAUTHORIZED,
  API_ERROR.ACCESS_DENIED,
  API_ERROR.PASSKEY_REQUIRED,
  API_ERROR.INVALID_ORIGIN,
  API_ERROR.SERVICE_UNAVAILABLE,
] as const;

// Codes that every vault key-changing POST (change-passphrase, rotate-key,
// recovery-key/generate) can only return before anything committed. Each
// caller adds its route's own pre-commit refusals; anything else — a rejected
// fetch, a body that is not the app envelope (a proxy's 502/504 page, the 500
// Next renders for an uncaught throw), or an unlisted code — leaves the
// outcome unknown.
//
// Emitted before the route runs: PROXY_PRE_ROUTE_REFUSALS.
// Emitted by each of those routes before its write: UNAUTHORIZED,
// RATE_LIMIT_EXCEEDED, SERVICE_UNAVAILABLE (limiter fail-closed),
// PAYLOAD_TOO_LARGE, INVALID_JSON, VALIDATION_ERROR, VAULT_NOT_SETUP,
// VERIFIER_NOT_SET (no stored passphrase verifier, checked before the
// transaction), INVALID_PASSPHRASE. Each caller first checks the passphrase
// against its local wrap, so an INVALID_PASSPHRASE that still arrives proves
// the verifier moved elsewhere: the callers lock on it, like on their route's
// compare-and-swap refusal, although it wrote nothing.
export const PRE_ROUTE_AND_PRE_TX_REFUSALS: ReadonlySet<string> = new Set([
  ...PROXY_PRE_ROUTE_REFUSALS,
  API_ERROR.RATE_LIMIT_EXCEEDED,
  API_ERROR.PAYLOAD_TOO_LARGE,
  API_ERROR.INVALID_JSON,
  API_ERROR.VALIDATION_ERROR,
  API_ERROR.VAULT_NOT_SETUP,
  API_ERROR.VERIFIER_NOT_SET,
  API_ERROR.INVALID_PASSPHRASE,
]);
