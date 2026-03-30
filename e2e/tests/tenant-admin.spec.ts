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
    // Navigate directly to the tenant admin page so the vault unlock and the
    // target page share the same React tree — no full reload needed after unlock.
    await page.goto("/ja/admin/tenant/members");
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(tenantAdmin.passphrase!);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("navigate to /tenant page and verify admin access", async () => {
    // beforeAll already unlocked on /ja/dashboard/tenant — we are already here.
    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("members tab is active by default and shows member list", async () => {
    const { tenantAdmin } = getAuthState();
    // Navigate back via sidebar click to preserve vault state.
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("adminConsole");

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

  test("current user appears in the members list", async () => {
    const { tenantAdmin } = getAuthState();
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("adminConsole");

    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The admin's own email should appear in the member list
    await expect(page.getByText(tenantAdmin.email)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("navigate to security policy tab and verify controls are displayed", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("adminConsole");

    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Click the Security tab
    await page.getByRole("tab", { name: /Security|セキュリティ/i }).click();

    // Session policy section should be visible
    await expect(
      page.getByText(/Session Policy|セッションポリシー/i),
    ).toBeVisible({ timeout: 5_000 });

    // The tab panel should contain at least one Save button for policy changes
    await expect(
      page.getByRole("tabpanel").getByRole("button", { name: /Save|保存/i }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("provisioning tab renders SCIM section", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("adminConsole");

    await expect(
      page.locator("h1").filter({ hasText: /Tenant Settings|テナント設定/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Click Provisioning tab
    await page.getByRole("tab", { name: /Provisioning|プロビジョニング/i }).click();

    // SCIM sub-tab should be selected and its content visible
    await expect(
      page.getByRole("tab", { name: /^SCIM$/i }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
