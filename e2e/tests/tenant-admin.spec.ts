import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

test.describe("Tenant Admin", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const { tenantAdmin } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, tenantAdmin.sessionToken);
    page = await context.newPage();
    // Unlock vault on dashboard first (admin pages don't have VaultGate)
    await page.goto("/ja/dashboard");
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(tenantAdmin.passphrase!);
    // Then navigate to admin
    await page.goto("/ja/admin/tenant/members");
    await page.waitForLoadState("networkidle");
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("navigate to /tenant page and verify admin access", async () => {
    await expect(
      page.getByRole("heading", { level: 1 })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("member list card is visible", async () => {
    await page.goto("/ja/admin/tenant/members");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("table, [data-slot='card']").first()).toBeVisible({ timeout: 10_000 });
  });

  test("security section is accessible", async () => {
    await page.goto("/ja/admin/tenant/security/session-policy");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { level: 1 })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("audit logs section is accessible", async () => {
    await page.goto("/ja/admin/tenant/audit-logs/logs");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { level: 1 })
    ).toBeVisible({ timeout: 10_000 });
  });
});
