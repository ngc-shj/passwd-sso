import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

test.describe("Bulk Operations", () => {
  let context: BrowserContext;
  let page: Page;

  const ts = Date.now();
  const titles = [
    `E2E Bulk A ${ts}`,
    `E2E Bulk B ${ts}`,
    `E2E Bulk C ${ts}`,
  ];

  test.beforeAll(async ({ browser }) => {
    const { vaultReady } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, vaultReady.sessionToken);
    page = await context.newPage();

    await page.goto("/ja/dashboard");
    const lockPage = new VaultLockPage(page);
    // Use a generous timeout: vault status check can be slow when the server
    // is processing other requests (vault setup check → /api/vault/status).
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 20_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("create 3 entries", async () => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    for (const title of titles) {
      await dashboard.createNewPassword();
      await entryPage.fill({ title, password: "E2EBulkP@ss1" });
      await entryPage.save();
      // After save, the list re-fetches (loading spinner → entries). Use a
      // generous timeout to ride out the loading state reliably.
      await expect(dashboard.entryByTitle(title)).toBeVisible({ timeout: 20_000 });
    }
  });

  test("enable selection mode and select all 3 entries", async () => {
    // Click the "Select" button to enter selection mode
    await page.getByRole("button", { name: /^Select$|^選択$/i }).click();

    // Selection mode should be active — checkboxes should appear
    // Select each entry by clicking its checkbox
    for (const title of titles) {
      const checkbox = page.getByRole("checkbox", { name: new RegExp(title) });
      await checkbox.check();
      await expect(checkbox).toBeChecked({ timeout: 5_000 });
    }

    // Verify selected count shows 3
    await expect(page.getByText(/3.*(selected|件選択中)/i)).toBeVisible({ timeout: 5_000 });
  });

  test("bulk archive moves all 3 entries to /archive", async () => {
    // Click "Move selected to archive" / "アーカイブへ移動" in the floating action bar
    await page.getByRole("button", { name: /Move selected to archive|アーカイブへ移動/i }).click();

    // Confirm dialog appears (AlertDialog uses role="alertdialog") — click Confirm
    await page.locator("[role='alertdialog']").waitFor({ timeout: 5_000 });
    await page.locator("[role='alertdialog']").getByRole("button", { name: /^Confirm$|^実行$/i }).click();
    await page.locator("[role='alertdialog']").waitFor({ state: "hidden", timeout: 15_000 });

    // All 3 entries should disappear from main list
    for (const title of titles) {
      await expect(page.getByText(title)).not.toBeVisible({ timeout: 10_000 });
    }

    // Navigate to /archive and verify all 3 appear
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("archive");
    await expect(page).toHaveURL(/\/archive/);

    for (const title of titles) {
      await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("bulk restore from /archive moves all entries back to main list", async () => {
    // Enable selection mode on archive view
    await page.getByRole("button", { name: /^Select$|^選択$/i }).click();

    // Select all 3 entries
    for (const title of titles) {
      const checkbox = page.getByRole("checkbox", { name: new RegExp(title) });
      await checkbox.check();
      await expect(checkbox).toBeChecked({ timeout: 5_000 });
    }

    // Click "Remove selected from archive" / "アーカイブ解除" in the floating action bar
    await page.getByRole("button", { name: /Remove selected from archive|アーカイブ解除/i }).click();

    // Confirm dialog (AlertDialog uses role="alertdialog")
    await page.locator("[role='alertdialog']").waitFor({ timeout: 5_000 });
    await page.locator("[role='alertdialog']").getByRole("button", { name: /^Confirm$|^実行$/i }).click();
    await page.locator("[role='alertdialog']").waitFor({ state: "hidden", timeout: 15_000 });

    // All entries should disappear from archive
    for (const title of titles) {
      await expect(page.getByText(title)).not.toBeVisible({ timeout: 10_000 });
    }

    // Navigate to main passwords and verify all 3 are back
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("passwords");

    for (const title of titles) {
      await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
    }
  });
});
