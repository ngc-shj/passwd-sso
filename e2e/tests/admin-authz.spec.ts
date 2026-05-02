/**
 * Authorization regression E2E — verifies admin pages reject non-admin access.
 *
 * Two boundaries are tested separately:
 *   1. Unauthenticated → outer /admin/layout.tsx redirects to /auth/signin.
 *      Test: final URL contains /auth/signin (Playwright follows the redirect).
 *   2. Authenticated non-admin (vaultReady) → outer admin layout passes
 *      (session valid), inner /admin/tenant/layout.tsx calls notFound() →
 *      HTTP 404 status.
 *
 * Why the asymmetry: outer layout's redirect is intentional (better UX —
 * unauthenticated users see the sign-in screen, not a confusing 404). The
 * 404 is reserved for "you're authenticated but not authorized" so URL
 * existence isn't disclosed to non-admins.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";

const ALL_TENANT_URLS: string[] = [
  "/ja/admin/tenant/members",
  "/ja/admin/tenant/teams",
  "/ja/admin/tenant/audit-logs",
  "/ja/admin/tenant/breakglass",
  "/ja/admin/tenant/machine-identity",
  "/ja/admin/tenant/machine-identity/service-accounts",
  "/ja/admin/tenant/machine-identity/service-accounts/accounts",
  "/ja/admin/tenant/machine-identity/service-accounts/access-requests",
  "/ja/admin/tenant/machine-identity/mcp-clients",
  "/ja/admin/tenant/machine-identity/operator-tokens",
  "/ja/admin/tenant/policies",
  "/ja/admin/tenant/policies/authentication",
  "/ja/admin/tenant/policies/authentication/password",
  "/ja/admin/tenant/policies/authentication/session",
  "/ja/admin/tenant/policies/authentication/passkey",
  "/ja/admin/tenant/policies/authentication/lockout",
  "/ja/admin/tenant/policies/machine-identity",
  "/ja/admin/tenant/policies/machine-identity/token",
  "/ja/admin/tenant/policies/machine-identity/delegation",
  "/ja/admin/tenant/policies/retention",
  "/ja/admin/tenant/policies/access-restriction",
  "/ja/admin/tenant/integrations",
  "/ja/admin/tenant/integrations/provisioning",
  "/ja/admin/tenant/integrations/provisioning/scim",
  "/ja/admin/tenant/integrations/provisioning/directory-sync",
  "/ja/admin/tenant/integrations/webhooks",
  "/ja/admin/tenant/integrations/audit-delivery",
];

// ── Unauthenticated: no storageState ─────────────────────────────────────────

test.describe("Admin authz — unauthenticated redirects to sign-in", () => {
  for (const url of ALL_TENANT_URLS) {
    test(`unauthenticated: ${url} → /auth/signin`, async ({ browser }) => {
      // Fresh context with no session cookie
      const context: BrowserContext = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(url);
        // Outer /admin/layout.tsx redirects unauthenticated users to the
        // sign-in page (better UX than 404). The redirect target retains
        // the locale segment.
        await expect(page).toHaveURL(/\/auth\/signin/);
      } finally {
        await context.close();
      }
    });
  }
});

// ── Non-admin user: vaultReady (not teamOwner) ────────────────────────────────

test.describe("Admin authz — non-admin user returns 404", () => {
  let context: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    const { vaultReady } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, vaultReady.sessionToken);
  });

  test.afterAll(async () => {
    await context.close();
  });

  for (const url of ALL_TENANT_URLS) {
    test(`vaultReady (non-admin): ${url} → 404`, async () => {
      const page = await context.newPage();
      try {
        const response = await page.goto(url);
        expect(response?.status()).toBe(404);
      } finally {
        await page.close();
      }
    });
  }
});
