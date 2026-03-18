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

test("Password CRUD lifecycle", async ({ context, page }) => {
  // Setup: inject session and unlock vault
  const { vaultReady } = getAuthState();
  await injectSession(context, vaultReady.sessionToken);
  await page.goto("/ja/dashboard");

  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  await lockPage.unlockAndWait(vaultReady.passphrase!);

  const dashboard = new DashboardPage(page);
  const entryPage = new PasswordEntryPage(page);

  await test.step("create a password entry", async () => {
    await dashboard.createNewPassword();

    await entryPage.fill(TEST_ENTRY);
    await entryPage.save();

    // Verify entry appears in list
    await expect(dashboard.entryByTitle(TEST_ENTRY.title)).toBeVisible({
      timeout: 10_000,
    });
  });

  await test.step("view password entry details", async () => {
    const entry = dashboard.entryByTitle(TEST_ENTRY.title);
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await entry.click();

    // Inline detail expands — should show decrypted details
    await expect(page.getByText(TEST_ENTRY.username)).toBeVisible({
      timeout: 10_000,
    });
  });

  const updatedTitle = `${TEST_ENTRY.title} (edited)`;

  await test.step("edit a password entry", async () => {
    const entry = dashboard.entryByTitle(TEST_ENTRY.title);
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await entry.click();

    // Wait for inline detail to expand (username visible)
    await expect(page.getByText(TEST_ENTRY.username)).toBeVisible({
      timeout: 10_000,
    });

    // Open edit dialog via ⋮ menu (scoped to this card)
    await entryPage.openEditDialog(TEST_ENTRY.title);

    // Change title in the edit dialog
    await entryPage.titleInput.clear();
    await entryPage.titleInput.fill(updatedTitle);
    await entryPage.updateButton.click();

    // Wait for edit dialog to close
    await page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 15_000,
    });

    // Verify updated entry
    await expect(dashboard.entryByTitle(updatedTitle)).toBeVisible({
      timeout: 10_000,
    });
  });

  await test.step("delete a password entry", async () => {
    const entry = dashboard.entryByTitle(updatedTitle);
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await entry.click();

    // Wait for inline detail to expand
    await expect(page.getByText(TEST_ENTRY.username)).toBeVisible({
      timeout: 10_000,
    });

    // Delete via ⋮ menu → confirmation dialog (scoped to this card)
    await entryPage.deleteEntry(updatedTitle);

    // Entry should no longer be in the active list (moved to trash)
    await expect(dashboard.entryByTitle(updatedTitle)).not.toBeVisible({
      timeout: 10_000,
    });
  });
});
