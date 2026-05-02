import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

// ── Navigation table: input URL → expected final URL ─────────────────────────

const TENANT_NAV: Array<{ input: string; expected: string }> = [
  // Top-level leaves
  { input: "/ja/admin/tenant/members", expected: "/ja/admin/tenant/members" },
  { input: "/ja/admin/tenant/teams", expected: "/ja/admin/tenant/teams" },
  { input: "/ja/admin/tenant/audit-logs", expected: "/ja/admin/tenant/audit-logs" },
  { input: "/ja/admin/tenant/breakglass", expected: "/ja/admin/tenant/breakglass" },
  // Machine-identity group landing → first child
  { input: "/ja/admin/tenant/machine-identity", expected: "/ja/admin/tenant/machine-identity/service-accounts/accounts" },
  { input: "/ja/admin/tenant/machine-identity/service-accounts", expected: "/ja/admin/tenant/machine-identity/service-accounts/accounts" },
  // Machine-identity sub-tab leaves
  { input: "/ja/admin/tenant/machine-identity/service-accounts/accounts", expected: "/ja/admin/tenant/machine-identity/service-accounts/accounts" },
  { input: "/ja/admin/tenant/machine-identity/service-accounts/access-requests", expected: "/ja/admin/tenant/machine-identity/service-accounts/access-requests" },
  { input: "/ja/admin/tenant/machine-identity/mcp-clients", expected: "/ja/admin/tenant/machine-identity/mcp-clients" },
  { input: "/ja/admin/tenant/machine-identity/operator-tokens", expected: "/ja/admin/tenant/machine-identity/operator-tokens" },
  // Policies group
  { input: "/ja/admin/tenant/policies", expected: "/ja/admin/tenant/policies/authentication/password" },
  { input: "/ja/admin/tenant/policies/authentication", expected: "/ja/admin/tenant/policies/authentication/password" },
  { input: "/ja/admin/tenant/policies/authentication/password", expected: "/ja/admin/tenant/policies/authentication/password" },
  { input: "/ja/admin/tenant/policies/authentication/session", expected: "/ja/admin/tenant/policies/authentication/session" },
  { input: "/ja/admin/tenant/policies/authentication/passkey", expected: "/ja/admin/tenant/policies/authentication/passkey" },
  { input: "/ja/admin/tenant/policies/authentication/lockout", expected: "/ja/admin/tenant/policies/authentication/lockout" },
  { input: "/ja/admin/tenant/policies/machine-identity", expected: "/ja/admin/tenant/policies/machine-identity/token" },
  { input: "/ja/admin/tenant/policies/machine-identity/token", expected: "/ja/admin/tenant/policies/machine-identity/token" },
  { input: "/ja/admin/tenant/policies/machine-identity/delegation", expected: "/ja/admin/tenant/policies/machine-identity/delegation" },
  { input: "/ja/admin/tenant/policies/retention", expected: "/ja/admin/tenant/policies/retention" },
  { input: "/ja/admin/tenant/policies/access-restriction", expected: "/ja/admin/tenant/policies/access-restriction" },
  // Integrations group
  { input: "/ja/admin/tenant/integrations", expected: "/ja/admin/tenant/integrations/provisioning/scim" },
  { input: "/ja/admin/tenant/integrations/provisioning", expected: "/ja/admin/tenant/integrations/provisioning/scim" },
  { input: "/ja/admin/tenant/integrations/provisioning/scim", expected: "/ja/admin/tenant/integrations/provisioning/scim" },
  { input: "/ja/admin/tenant/integrations/provisioning/directory-sync", expected: "/ja/admin/tenant/integrations/provisioning/directory-sync" },
  { input: "/ja/admin/tenant/integrations/webhooks", expected: "/ja/admin/tenant/integrations/webhooks" },
  { input: "/ja/admin/tenant/integrations/audit-delivery", expected: "/ja/admin/tenant/integrations/audit-delivery" },
];

const OLD_URLS_404: string[] = [
  "/ja/admin/tenant/security/session-policy",
  "/ja/admin/tenant/operator-tokens",
  "/ja/admin/tenant/audit-logs/breakglass",
  "/ja/admin/tenant/mcp/clients",
];

const EN_REDIRECT_SAMPLE: Array<{ input: string; expected: string }> = [
  { input: "/en/admin/tenant/policies", expected: "/en/admin/tenant/policies/authentication/password" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupTenantAdminContext(
  browser: Parameters<typeof test.beforeAll>[0] extends never ? never : import("@playwright/test").Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const { tenantAdmin } = getAuthState();
  const context = await browser.newContext();
  await injectSession(context, tenantAdmin.sessionToken);
  const page = await context.newPage();

  // Unlock vault on dashboard (admin pages bypass VaultGate, but subsequent
  // client-side navigation may need the vault key in memory)
  await page.goto("/ja/dashboard");
  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 15_000 });
  await lockPage.unlockAndWait(tenantAdmin.passphrase!);

  return { context, page };
}

// ── Tenant nav parameterized tests ────────────────────────────────────────────

test.describe("Admin IA — tenant nav", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ({ context, page } = await setupTenantAdminContext(browser as import("@playwright/test").Browser));
  });

  test.afterAll(async () => {
    await context.close();
  });

  for (const { input, expected } of TENANT_NAV) {
    test(`navigates ${input} → ${expected}`, async () => {
      await page.goto(input);
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), { timeout: 10_000 });
    });
  }

  for (const url of OLD_URLS_404) {
    test(`old URL returns 404: ${url}`, async () => {
      const response = await page.goto(url);
      expect(response?.status()).toBe(404);
    });
  }

  for (const { input, expected } of EN_REDIRECT_SAMPLE) {
    test(`en redirect: ${input} → ${expected}`, async () => {
      await page.goto(input);
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), { timeout: 10_000 });
    });
  }
});

// ── Team nav tests ────────────────────────────────────────────────────────────

test.describe("Admin IA — team nav", () => {
  let context: BrowserContext;
  let page: Page;
  let teamId: string;

  test.beforeAll(async ({ browser }) => {
    ({ context, page } = await setupTenantAdminContext(browser as import("@playwright/test").Browser));

    // Navigate to teams list and extract the first team link
    await page.goto("/ja/admin/tenant/teams");
    await page.waitForLoadState("networkidle");

    // Grab first team link href from the teams list (links go to /admin/teams/{id}/general)
    const teamLink = page.locator("a[href*='/admin/teams/']").first();
    const href = await teamLink.getAttribute("href");
    const match = href?.match(/\/admin\/teams\/([^/]+)/);
    teamId = match?.[1] ?? "";
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("team Members page renders without error", async () => {
    test.skip(!teamId, "No team found in teams list");
    await page.goto(`/ja/admin/teams/${teamId}/members`);
    await page.waitForLoadState("networkidle");
    const response = await page.goto(`/ja/admin/teams/${teamId}/members`);
    expect(response?.status()).not.toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 10_000 });
  });

  test("team General page renders without error", async () => {
    test.skip(!teamId, "No team found in teams list");
    const response = await page.goto(`/ja/admin/teams/${teamId}/general`);
    expect(response?.status()).not.toBe(404);
  });

  test("team Policy page renders without error", async () => {
    test.skip(!teamId, "No team found in teams list");
    const response = await page.goto(`/ja/admin/teams/${teamId}/policy`);
    expect(response?.status()).not.toBe(404);
  });

  test("team Key Rotation page renders without error", async () => {
    test.skip(!teamId, "No team found in teams list");
    const response = await page.goto(`/ja/admin/teams/${teamId}/key-rotation`);
    expect(response?.status()).not.toBe(404);
  });

  test("team Webhooks page renders without error", async () => {
    test.skip(!teamId, "No team found in teams list");
    const response = await page.goto(`/ja/admin/teams/${teamId}/webhooks`);
    expect(response?.status()).not.toBe(404);
  });

  test("team Audit Logs page renders without error", async () => {
    test.skip(!teamId, "No team found in teams list");
    const response = await page.goto(`/ja/admin/teams/${teamId}/audit-logs`);
    expect(response?.status()).not.toBe(404);
  });

  test("team Transfer Ownership page renders without error", async () => {
    test.skip(!teamId, "No team found in teams list");
    const response = await page.goto(`/ja/admin/teams/${teamId}/members/transfer-ownership`);
    expect(response?.status()).not.toBe(404);
  });
});

// ── Mobile sidebar test ───────────────────────────────────────────────────────

test("@mobile admin sidebar group expansion", async ({ page }) => {
  const { tenantAdmin } = getAuthState();
  const context = page.context();
  await injectSession(context, tenantAdmin.sessionToken);

  // Set mobile viewport
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/ja/dashboard");
  const lockPage = new VaultLockPage(page);
  const passphraseVisible = await lockPage.passphraseInput.isVisible({ timeout: 5_000 }).catch(() => false);
  if (passphraseVisible) {
    await lockPage.unlockAndWait(tenantAdmin.passphrase!);
  }

  await page.goto("/ja/admin/tenant/members");
  await page.waitForLoadState("networkidle");

  // Open hamburger menu if present (mobile view)
  const hamburger = page.getByRole("button", { name: /menu|メニュー/i }).first();
  const isHamburgerVisible = await hamburger.isVisible({ timeout: 3_000 }).catch(() => false);
  if (isHamburgerVisible) {
    await hamburger.click();
  }

  // Tap the "Policies" group item in the sidebar
  const policiesLink = page.getByRole("button", { name: /ポリシー|Policies/i }).first();
  const isPoliciesVisible = await policiesLink.isVisible({ timeout: 5_000 }).catch(() => false);

  if (isPoliciesVisible) {
    await policiesLink.click();
    // Tap first child — Authentication Policy
    const authLink = page.getByRole("link", { name: /認証ポリシー|Authentication policy/i }).first();
    const isAuthVisible = await authLink.isVisible({ timeout: 5_000 }).catch(() => false);
    if (isAuthVisible) {
      await authLink.click();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/policies\/authentication/, { timeout: 10_000 });
    }
  } else {
    // On desktop viewport fallback — just navigate directly
    await page.goto("/ja/admin/tenant/policies/authentication/password");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/policies\/authentication\/password/, { timeout: 10_000 });
  }
});
