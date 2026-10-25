/**
 * Shared configuration for k6 load test scenarios.
 */

export const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

/**
 * Session cookie name: the one Auth.js reads in the target deployment
 * (src/lib/auth/session/cookie-name.ts). Any other name is not a session.
 *   http (AUTH_URL http://...)          → "authjs.session-token"
 *   https with NEXT_PUBLIC_BASE_PATH    → "__Secure-authjs.session-token"
 *   https at the root (no basePath)     → "__Host-authjs.session-token"
 * Defaults to the http name; set COOKIE_NAME for an https target.
 */
export const COOKIE_NAME =
  __ENV.COOKIE_NAME || "authjs.session-token";

/** Default thresholds applied to all scenarios. */
export const DEFAULT_THRESHOLDS = {
  http_req_duration: ["p(95)<500", "p(99)<1500"],
  http_req_failed: ["rate<0.01"],
  checks: ["rate>0.99"],
};
