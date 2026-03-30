import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SettingsPage } from "../page-objects/settings.page";

/**
 * Key Rotation test.
 *
 * Uses the dedicated `keyRotation` user (DESTRUCTIVE — rotates encryption key).
 * Creates a password entry before rotation and verifies it is still readable
 * after the key has been rotated.
 */
test("Key rotation preserves existing vault entries", async ({
  context,
  page,
}) => {
  const { keyRotation } = getAuthState();
  await injectSession(context, keyRotation.sessionToken);
  await page.goto("/ja/dashboard");

  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  await lockPage.unlockAndWait(keyRotation.passphrase!);

  const dashboard = new DashboardPage(page);
  const entryPage = new PasswordEntryPage(page);
  const settings = new SettingsPage(page);

  const testEntry = {
    title: `Key Rotation Test ${Date.now()}`,
    username: "rotation-user@example.com",
    password: "BeforeRotation!99",
  };

  await test.step("create a test password entry", async () => {
    await dashboard.createNewPassword();
    await entryPage.fill(testEntry);
    await entryPage.save();

    await expect(dashboard.entryByTitle(testEntry.title)).toBeVisible({
      timeout: 10_000,
    });
  });

  await test.step("navigate to Settings > Security (Key Rotation)", async () => {
    await settings.gotoSecurity();
    // Navigating to a new page resets React state; re-unlock the vault
    await lockPage.unlockAndWait(keyRotation.passphrase!);

    // The rotate key card should be visible
    await expect(
      page.getByRole("button", {
        name: /Rotate Key|キーをローテーション/i,
      })
    ).toBeVisible({ timeout: 5_000 });
  });

  await test.step("trigger key rotation", async () => {
    await page
      .getByRole("button", { name: /Rotate Key|キーをローテーション/i })
      .click();

    // Rotation dialog opens
    await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });

    // Enter passphrase to confirm
    await page.locator("#rk-passphrase").fill(keyRotation.passphrase!);

    await page
      .locator("[role='dialog']")
      .getByRole("button", {
        name: /Rotate Key|キーをローテーション/i,
      })
      .click();

    // Wait for the dialog to close (rotation completes)
    await page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 120_000,
    });
  });

  await test.step("verify test entry is still accessible after rotation", async () => {
    await page.goto("/ja/dashboard");

    // Full page navigation resets React state; re-unlock with the same passphrase
    // (key rotation keeps the passphrase unchanged — only the derived key is rotated)
    await lockPage.unlockAndWait(keyRotation.passphrase!);

    // Entry should still appear in the list
    await expect(dashboard.entryByTitle(testEntry.title)).toBeVisible({
      timeout: 10_000,
    });

    // Click to expand inline detail — decrypted data should be visible
    await dashboard.entryByTitle(testEntry.title).click();
    await expect(page.getByText(testEntry.username)).toBeVisible({
      timeout: 10_000,
    });
  });
});
