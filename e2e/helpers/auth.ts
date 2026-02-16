/**
 * Session cookie injection helper for E2E tests.
 *
 * Resolves cookie name and attributes based on AUTH_URL environment variable,
 * matching the naming convention in src/proxy.ts:182-188.
 */
import type { BrowserContext } from "@playwright/test";

function isSecureEnvironment(): boolean {
  const url = process.env.AUTH_URL ?? "http://localhost:3000";
  return url.startsWith("https://");
}

function getSessionCookieName(): string {
  return isSecureEnvironment()
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
  const secure = isSecureEnvironment();
  await context.addCookies([
    {
      name: getSessionCookieName(),
      value: sessionToken,
      domain: "localhost",
      path: "/",
      ...(secure && { secure: true }),
    },
  ]);
}
