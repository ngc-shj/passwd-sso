/**
 * Session cookie injection helper for E2E tests.
 *
 * Resolves cookie name and attributes based on AUTH_URL environment variable,
 * matching the naming convention in src/proxy.ts.
 */
import type { BrowserContext } from "@playwright/test";
import { isHttps } from "../../src/lib/url-helpers";

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
      domain: "localhost",
      path: "/",
      ...(isHttps && { secure: true }),
    },
  ]);
}
