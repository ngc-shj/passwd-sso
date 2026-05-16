/**
 * Single source of truth for the Auth.js session-cookie name selection.
 *
 * The cookie name varies along two axes:
 *   - `useSecureCookies`: true when AUTH_URL is HTTPS (production-shape).
 *     Drives the `__Secure-` / `__Host-` prefix.
 *   - `basePath`: when set, the cookie path becomes `${basePath}/`. The
 *     `__Host-` prefix per RFC 6265bis §4.1.3.2 mandates `Path=/`, so we
 *     can only use `__Host-` when basePath is unset.
 *
 * The post-merge review of PR #465 found that this selection had been
 * inlined in 5 different places (auth.config.ts + 4 consumers) and that
 * the original PR updated only one site — breaking sign-in in any
 * deployment where the cookie name diverged from what the proxy/helpers
 * expected. Centralizing here closes that propagation gap structurally.
 */

/**
 * Returns the cookie name Auth.js currently emits given the deployment
 * configuration.
 *
 *   useSecureCookies=false                       → "authjs.session-token"
 *   useSecureCookies=true && basePath set         → "__Secure-authjs.session-token"
 *   useSecureCookies=true && basePath unset/empty → "__Host-authjs.session-token"
 */
export function getSessionCookieName(opts: {
  useSecureCookies: boolean;
  basePath: string | undefined;
}): string {
  if (!opts.useSecureCookies) return "authjs.session-token";
  if (opts.basePath && opts.basePath.length > 0) return "__Secure-authjs.session-token";
  return "__Host-authjs.session-token";
}

/**
 * All cookie names the proxy / session-extraction / logout-cleanup paths
 * must recognize. Includes:
 *   - All three current-issue shapes (`authjs.session-token`,
 *     `__Secure-authjs.session-token`, `__Host-authjs.session-token`)
 *   - Legacy `next-auth.session-token` / `__Secure-next-auth.session-token`
 *     so logout-cleanup can sweep cookies left over by browsers that still
 *     carry them from older Auth.js (v4 / next-auth) deployments.
 */
export const ALL_KNOWN_SESSION_COOKIE_NAMES = [
  "__Host-authjs.session-token",
  "__Secure-authjs.session-token",
  "authjs.session-token",
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

/**
 * `useSecureCookies` derivation from AUTH_URL / NEXTAUTH_URL.
 * Mirrors Auth.js's own derivation in `core/lib/cookie.ts` so callers
 * that are NOT inside the Auth.js config (e.g. the sessions list helper,
 * the passkey verify route) compute the same value.
 *
 * Falls back to `NODE_ENV === "production"` only when the URL is missing
 * or unparseable, which preserves the previous behavior of
 * `src/app/api/sessions/helpers.ts:isSecureCookie`.
 */
export function isSecureCookieFromAuthUrl(): boolean {
  const authUrl = process.env.AUTH_URL || process.env.NEXTAUTH_URL || "";
  try {
    return new URL(authUrl).protocol === "https:";
  } catch {
    return process.env.NODE_ENV === "production";
  }
}
