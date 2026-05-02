import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

const LOCK_BUTTON_LABEL = /保管庫をロック|Lock Vault/i;

test.describe("Vault Lock and Relock", () => {
  test.beforeEach(async ({ context }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
  });

  test("manual lock via header LockVaultButton", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    // Unlock first
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Click the header LockVaultButton (replaced the old dropdown menuitem
    // in the personal-security IA redesign).
    await page.locator("header").getByRole("button", { name: LOCK_BUTTON_LABEL }).click();

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

    // Lock via header icon button
    await page.locator("header").getByRole("button", { name: LOCK_BUTTON_LABEL }).click();

    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    // Unlock again
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Should be back on dashboard
    await expect(lockPage.passphraseInput).not.toBeVisible();
  });
});
