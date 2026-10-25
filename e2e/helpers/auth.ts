/**
 * Session cookie injection helper for E2E tests.
 *
 * Resolves cookie name and attributes based on AUTH_URL environment variable,
 * matching the naming convention in src/proxy.ts.
 */
import type { BrowserContext } from "@playwright/test";
import {
  configuredSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "../../src/lib/auth/session/cookie-name";

/**
 * Resolve the cookie target URL from the test base URL.
 *
 * WebKit (mobile-ios project) rejects cookies set via domain/path with
 * `domain: "localhost"`, which Chromium accepts. Using the `url` form lets
 * Playwright derive cookie attributes (domain, path, secure, sameSite) in
 * a browser-agnostic way.
 */
function getCookieUrl(): string {
  return process.env.E2E_BASE_URL ?? "http://localhost:3000";
}

/**
 * Inject a session cookie into the browser context.
 * Uses the `url` form so cookie attributes are browser-agnostic.
 */
export async function injectSession(
  context: BrowserContext,
  sessionToken: string,
): Promise<void> {
  await context.addCookies([
    {
      name: configuredSessionCookieName(),
      value: sessionToken,
      url: getCookieUrl(),
      // Every attribute set here matches the production session cookie in
      // auth.config.ts (`sameSite: "lax"`, `httpOnly: true`, `secure` from
      // the same AUTH_URL derivation). Diverging from production lets a
      // future E2E test pass where production would have dropped or hidden
      // the cookie (cross-site, or read from page script), or fail where
      // production works.
      sameSite: "Lax",
      httpOnly: true,
      ...(isSecureCookieFromAuthUrl() && { secure: true }),
    },
  ]);
}
