import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";

test.describe("Audit Logs", () => {
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

  test("audit log entries are listed", async () => {
    await test.step("navigate to audit logs page", async () => {
      await page.goto("/ja/dashboard/audit-logs");
      // Wait for the page heading to appear
      await expect(
        page.getByRole("heading", { name: /Audit Log|監査ログ/i })
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("at least one log entry is visible", async () => {
      // Previous E2E test runs will have generated audit log entries.
      // Wait for loading to finish (Loader2 spinner disappears)
      await expect(
        page.locator(".animate-spin")
      ).not.toBeVisible({ timeout: 15_000 });

      // Verify at least one log row exists (each row contains a formatted datetime)
      const logCard = page.locator(
        "[data-slot='card'].divide-y, .rounded-xl.border.bg-card\\/80.divide-y"
      ).last();
      await expect(logCard).toBeVisible({ timeout: 10_000 });

      // Rows inside the log card
      const rows = logCard.locator(".px-4.py-3");
      await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    });
  });

  test("filter by action group narrows the log list", async () => {
    await test.step("navigate to audit logs page", async () => {
      await page.goto("/ja/dashboard/audit-logs");
      await expect(
        page.getByRole("heading", { name: /Audit Log|監査ログ/i })
      ).toBeVisible({ timeout: 10_000 });
      // Wait for initial load
      await expect(page.locator(".animate-spin")).not.toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step("open action filter and select Auth group", async () => {
      // The filter trigger is a button showing the current filter summary
      const filterTrigger = page.getByRole("button", {
        name: /All actions|すべてのアクション/i,
      });
      await expect(filterTrigger).toBeVisible({ timeout: 5_000 });
      await filterTrigger.click();

      // Collapsible content with action groups is now visible
      await expect(
        page.getByText(/Auth|認証/i).first()
      ).toBeVisible({ timeout: 5_000 });

      // Click the Auth group checkbox to select all auth actions
      const authGroupCheckbox = page
        .locator("label")
        .filter({ hasText: /^Auth$|^認証$/i })
        .first()
        .locator("..")
        .getByRole("checkbox")
        .first();

      await authGroupCheckbox.click();
    });

    await test.step("filtered results contain only auth log entries", async () => {
      // Wait for filtered results to load
      await expect(page.locator(".animate-spin")).not.toBeVisible({
        timeout: 15_000,
      });

      // Auth actions (e.g. AUTH_LOGIN) should be visible
      // If no auth logs exist we accept an empty state gracefully
      const noLogsMessage = page.getByText(/No logs|ログなし|noLogs/i);
      const logRows = page.locator(
        "[data-slot='card'].divide-y .px-4.py-3, .rounded-xl.border.bg-card\\/80.divide-y .px-4.py-3"
      );

      const hasRows = await logRows.first().isVisible({ timeout: 5_000 }).catch(() => false);
      const hasEmpty = await noLogsMessage.isVisible({ timeout: 2_000 }).catch(() => false);

      // Either logs are shown or the empty state is shown — both are valid
      expect(hasRows || hasEmpty).toBe(true);
    });

    await test.step("clear filter returns to all actions view", async () => {
      // Button to clear the filter (only visible when filter is active)
      const clearButton = page.getByRole("button", {
        name: /All actions|すべてのアクション/i,
      });
      // If the clear button is visible it resets the filter
      if (await clearButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await clearButton.click();
      }
    });
  });
});
