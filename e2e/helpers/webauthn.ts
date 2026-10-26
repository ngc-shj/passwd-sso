/**
 * The relying party the E2E server runs as, and a virtual authenticator that
 * matches it.
 *
 * One place for the RP ID and origin: the Playwright web server is started
 * with E2E_WEBAUTHN_SERVER_ENV (playwright.config.ts), in CI and locally
 * alike, and specs compare the server's registration options against
 * E2E_WEBAUTHN_RP_ID. A developer `.env` usually names a public host as
 * WEBAUTHN_RP_ID, under which no ceremony against localhost can succeed.
 */
import type { CDPSession, Page } from "@playwright/test";

/** The URL the suite drives (see playwright.config.ts). */
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export const E2E_WEBAUTHN_RP_ID = new URL(E2E_BASE_URL).hostname;
export const E2E_WEBAUTHN_RP_ORIGIN = new URL(E2E_BASE_URL).origin;

/** Environment the E2E web server is started with. */
export const E2E_WEBAUTHN_SERVER_ENV = {
  WEBAUTHN_RP_ID: E2E_WEBAUTHN_RP_ID,
  WEBAUTHN_RP_ORIGIN: E2E_WEBAUTHN_RP_ORIGIN,
};

/**
 * A CDP virtual authenticator matching the server's registration options
 * (src/lib/auth/webauthn/webauthn-server.ts: user verification required,
 * resident key preferred) with the PRF extension. Chromium only.
 */
export async function addPrfVirtualAuthenticator(
  page: Page
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}
