/**
 * Shared configuration for k6 load test scenarios.
 */

export const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

/**
 * Session cookie name.
 * Dev (http): "authjs.session-token"
 * Prod (https): "__Secure-authjs.session-token"
 * Override with COOKIE_NAME env var if needed.
 */
export const COOKIE_NAME =
  __ENV.COOKIE_NAME || "authjs.session-token";

/** Default thresholds applied to all scenarios. */
export const DEFAULT_THRESHOLDS = {
  http_req_duration: ["p(95)<500", "p(99)<1500"],
  http_req_failed: ["rate<0.01"],
  checks: ["rate>0.99"],
};
