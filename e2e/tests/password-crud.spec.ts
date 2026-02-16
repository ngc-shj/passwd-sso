import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";

const TEST_ENTRY = {
  title: `E2E Test Entry ${Date.now()}`,
  username: "e2e-user@example.com",
  password: "E2ESecretPassword!123",
  url: "https://e2e-test.example.com",
  notes: "Created by E2E test",
};

/**
 * Tests run sequentially within the describe block (workers: 1).
 * create → view → edit → delete form a chain — each depends on the prior.
 * IMPROVE(#27): consolidate into test.step or use independent data per test
 */
test.describe("Password CRUD", () => {
  test.beforeEach(async ({ context, page }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/dashboard");

    // Unlock vault
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);
  });

  test("create a password entry", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    await dashboard.createNewPassword();

    await entryPage.fill(TEST_ENTRY);
    await entryPage.save();

    // Verify entry appears in list
    await expect(dashboard.entryByTitle(TEST_ENTRY.title)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("view password entry details", async ({ page }) => {
    const dashboard = new DashboardPage(page);

    // Entry must exist (created by previous test)
    const entry = dashboard.entryByTitle(TEST_ENTRY.title);
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await entry.click();

    // Should show decrypted details
    await expect(page.getByText(TEST_ENTRY.username)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("edit a password entry", async ({ page }) => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    const entry = dashboard.entryByTitle(TEST_ENTRY.title);
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await entry.click();

    // Navigate to edit
    await entryPage.editButton.click();
    await page.waitForURL(/\/edit/);

    // Change title
    const updatedTitle = `${TEST_ENTRY.title} (edited)`;
    await entryPage.titleInput.clear();
    await entryPage.titleInput.fill(updatedTitle);
    await entryPage.updateButton.click();

    // Wait for save
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

    // Verify updated entry
    await expect(dashboard.entryByTitle(updatedTitle)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("delete a password entry", async ({ page }) => {
    const entryPage = new PasswordEntryPage(page);

    // Find entry with our test title (may be original or edited)
    const entry = page.getByText(/E2E Test Entry/).first();
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await entry.click();

    // Delete via confirmation dialog
    await entryPage.deleteButton.click();
    await entryPage.deleteConfirmButton.click();

    // Wait for return to dashboard
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

    // Entry should no longer be in the active list (moved to trash)
    await expect(page.getByText(/E2E Test Entry/)).not.toBeVisible({
      timeout: 10_000,
    });
  });
});
