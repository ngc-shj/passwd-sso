/**
 * Session cookie injection helper for E2E tests.
 *
 * Resolves cookie name, domain, and secure flag from AUTH_URL / E2E_BASE_URL,
 * matching the naming convention in src/proxy.ts.
 */
import type { BrowserContext } from "@playwright/test";
import { isHttps } from "../../src/lib/url-helpers";

// Derive the cookie domain from the same URL the app and Playwright use.
const cookieDomain = (() => {
  const raw =
    process.env.E2E_BASE_URL ?? process.env.AUTH_URL ?? "http://localhost:3000";
  try {
    return new URL(raw).hostname;
  } catch {
    return "localhost";
  }
})();

function getSessionCookieName(): string {
  return isHttps
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

/**
 * Inject a session cookie into the browser context.
 * Handles cookie name and secure attribute based on environment.
 */
export async function injectSession(
  context: BrowserContext,
  sessionToken: string
): Promise<void> {
  await context.addCookies([
    {
      name: getSessionCookieName(),
      value: sessionToken,
      domain: cookieDomain,
      path: "/",
      ...(isHttps && { secure: true }),
    },
  ]);
}
