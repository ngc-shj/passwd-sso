/**
 * Authorization regression E2E — verifies that admin pages return 404 for
 * unauthenticated requests and for authenticated non-admin users.
 *
 * Round-2 findings addressed:
 *   S7  — use vaultReady (non-admin) fixture, NOT teamOwner
 *   S10 — redirect-only pages must 404 before redirect fires (layout notFound() guard)
 *   T21 — assert response.status() === 404, not just URL
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

test.describe("Admin authz — unauthenticated returns 404", () => {
  for (const url of ALL_TENANT_URLS) {
    test(`unauthenticated: ${url} → 404`, async ({ browser }) => {
      // Fresh context with no session cookie
      const context: BrowserContext = await browser.newContext();
      const page = await context.newPage();
      try {
        const response = await page.goto(url);
        expect(response?.status()).toBe(404);
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
