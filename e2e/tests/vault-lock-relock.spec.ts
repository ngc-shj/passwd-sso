import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

test.describe("Vault Lock and Relock", () => {
  test.beforeEach(async ({ context }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
  });

  test("manual lock via header menu", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    // Unlock first
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Open user menu and click Lock
    const userMenuButton = page.locator("header").getByRole("button").last();
    await userMenuButton.click();

    const lockMenuItem = page.getByRole("menuitem", {
      name: /Lock Vault|Vaultをロック/i,
    });
    await lockMenuItem.click();

    // Should show lock screen again
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  });

  test("relock then unlock restores access", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    // First unlock
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Lock
    const userMenuButton = page.locator("header").getByRole("button").last();
    await userMenuButton.click();
    await page
      .getByRole("menuitem", { name: /Lock Vault|Vaultをロック/i })
      .click();

    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    // Unlock again
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Should be back on dashboard
    await expect(lockPage.passphraseInput).not.toBeVisible();
  });
});
