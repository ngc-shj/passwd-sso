import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { SettingsPage } from "../page-objects/settings.page";

test.describe("Settings - Sessions", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const { vaultReady } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, vaultReady.sessionToken);
    page = await context.newPage();
    await page.goto("/ja/dashboard");
    const lockPage = new VaultLockPage(page);
    await lockPage.unlockAndWait(vaultReady.passphrase!);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("active session is listed in Account tab", async () => {
    const { vaultReady } = getAuthState();
    const settingsPage = new SettingsPage(page);
    const lockPage = new VaultLockPage(page);

    await test.step("navigate to settings and unlock vault", async () => {
      await page.goto("/ja/dashboard/settings");
      // Navigating to a new page resets React state; re-unlock the vault
      await lockPage.unlockAndWait(vaultReady.passphrase!);
      await expect(settingsPage.accountTab).toBeVisible({ timeout: 10_000 });
    });

    await test.step("switch to Account tab", async () => {
      await settingsPage.switchTab("account");
    });

    await test.step("sessions card is visible and lists the current session", async () => {
      // Sessions card renders under the Account tab
      await expect(settingsPage.sessionsCard).toBeVisible({ timeout: 10_000 });

      // At least one session row should be present (the E2E session itself)
      const sessionRows = settingsPage.sessionsCard.locator(
        ".px-4.py-3"
      );
      await expect(sessionRows.first()).toBeVisible({ timeout: 10_000 });
    });

    await test.step("current session badge is visible", async () => {
      // The injected session token is marked as current
      // Sessions card renders a "current" badge on the active row
      await expect(
        page.getByText(/^Current$|^現在$|current/i).first()
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("session shows last-active timestamp", async () => {
      // Each session row contains a "Last active:" label
      await expect(
        page.getByText(/Last active|最終アクティブ/i).first()
      ).toBeVisible({ timeout: 10_000 });
    });
  });
});
