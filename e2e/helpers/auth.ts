/**
 * Session cookie injection helper for E2E tests.
 *
 * Resolves cookie name and attributes based on AUTH_URL environment variable,
 * matching the naming convention in src/proxy.ts.
 */
import type { BrowserContext } from "@playwright/test";
import {
  getSessionCookieName as resolveSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "../../src/lib/auth/session/cookie-name";

function getSessionCookieName(): string {
  return resolveSessionCookieName({
    useSecureCookies: isSecureCookieFromAuthUrl(),
    basePath: process.env.NEXT_PUBLIC_BASE_PATH,
  });
}

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
  sessionToken: string
): Promise<void> {
  await context.addCookies([
    {
      name: getSessionCookieName(),
      value: sessionToken,
      url: getCookieUrl(),
      // Match the production session cookie attribute set in auth.config.ts.
      // Diverging from production lets a future cross-site E2E test pass
      // while production would have dropped the cookie.
      sameSite: "Strict",
      ...(isSecureCookieFromAuthUrl() && { secure: true }),
    },
  ]);
}
