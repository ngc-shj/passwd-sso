import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

test.describe("Tenant Admin", () => {
  test.beforeEach(async ({ context }) => {
    const { tenantAdmin } = getAuthState();
    await injectSession(context, tenantAdmin.sessionToken);
  });

  test("navigate to /tenant page and verify admin access", async ({ page }) => {
    const { tenantAdmin } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(tenantAdmin.passphrase!);

    await page.goto("/ja/dashboard/tenant");

    // The tenant settings page heading should be visible (not the "no access" message)
    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("members tab is active by default and shows member list", async ({
    page,
  }) => {
    const { tenantAdmin } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(tenantAdmin.passphrase!);

    await page.goto("/ja/dashboard/tenant");
    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Members tab should be selected by default
    const membersTab = page.getByRole("tab", { name: /Members|メンバー/i });
    await expect(membersTab).toBeVisible({ timeout: 5_000 });
    await expect(membersTab).toHaveAttribute("data-state", "active");

    // The tab panel content should include at minimum the tenant admin themselves
    await expect(
      page.getByRole("tabpanel").filter({ hasText: tenantAdmin.email }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("current user appears in the members list", async ({ page }) => {
    const { tenantAdmin } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(tenantAdmin.passphrase!);

    await page.goto("/ja/dashboard/tenant");
    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The admin's own email should appear in the member list
    await expect(page.getByText(tenantAdmin.email)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("navigate to security policy tab and verify controls are displayed", async ({
    page,
  }) => {
    const { tenantAdmin } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(tenantAdmin.passphrase!);

    await page.goto("/ja/dashboard/tenant");
    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Click the Security tab
    await page.getByRole("tab", { name: /Security|セキュリティ/i }).click();

    // Session policy section should be visible
    await expect(
      page.getByText(/Session Policy|セッションポリシー/i),
    ).toBeVisible({ timeout: 5_000 });

    // The tab panel should contain a Save button for policy changes
    await expect(
      page.getByRole("tabpanel").getByRole("button", { name: /Save|保存/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("provisioning tab renders SCIM section", async ({ page }) => {
    const { tenantAdmin } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(tenantAdmin.passphrase!);

    await page.goto("/ja/dashboard/tenant");
    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Click Provisioning tab
    await page.getByRole("tab", { name: /Provisioning|プロビジョニング/i }).click();

    // SCIM sub-tab content should render
    await expect(
      page.getByText(/SCIM/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});
