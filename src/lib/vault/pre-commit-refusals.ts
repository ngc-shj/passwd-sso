import { API_ERROR } from "@/lib/http/api-error-codes";

// Codes that every vault key-changing POST (change-passphrase, rotate-key,
// recovery-key/generate) can only return before anything committed. Each
// caller adds its route's own pre-commit refusals; anything else — a rejected
// fetch, a body that is not the app envelope (a proxy's 502/504 page, the 500
// Next renders for an uncaught throw), or an unlisted code — leaves the
// outcome unknown.
//
// Emitted before the route runs (src/lib/proxy/*, csrf.ts): UNAUTHORIZED,
// ACCESS_DENIED, PASSKEY_REQUIRED, INVALID_ORIGIN, FORBIDDEN,
// SERVICE_UNAVAILABLE.
// Emitted by each of those routes before its write: UNAUTHORIZED,
// RATE_LIMIT_EXCEEDED, SERVICE_UNAVAILABLE (limiter fail-closed),
// PAYLOAD_TOO_LARGE, INVALID_JSON, VALIDATION_ERROR, VAULT_NOT_SETUP,
// INVALID_PASSPHRASE.
export const PRE_ROUTE_AND_PRE_TX_REFUSALS = [
  API_ERROR.UNAUTHORIZED,
  API_ERROR.ACCESS_DENIED,
  API_ERROR.PASSKEY_REQUIRED,
  API_ERROR.INVALID_ORIGIN,
  API_ERROR.FORBIDDEN,
  API_ERROR.SERVICE_UNAVAILABLE,
  API_ERROR.RATE_LIMIT_EXCEEDED,
  API_ERROR.PAYLOAD_TOO_LARGE,
  API_ERROR.INVALID_JSON,
  API_ERROR.VALIDATION_ERROR,
  API_ERROR.VAULT_NOT_SETUP,
  API_ERROR.INVALID_PASSPHRASE,
] as const;
