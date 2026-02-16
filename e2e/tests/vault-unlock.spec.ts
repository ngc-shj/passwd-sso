import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

test.describe("Vault Unlock", () => {
  test.beforeEach(async ({ context }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
  });

  test("unlock with correct passphrase", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Should show dashboard content (lock screen hidden)
    await expect(lockPage.passphraseInput).not.toBeVisible();
  });

  test("wrong passphrase shows error", async ({ page }) => {
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await lockPage.unlock("WrongPassphrase!2026");

    // Should show error message
    await expect(lockPage.errorMessage).toBeVisible({ timeout: 10_000 });
  });

  test("page reload returns to lock screen", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await lockPage.unlockAndWait(vaultReady.passphrase!);
    await expect(lockPage.passphraseInput).not.toBeVisible();

    // Reload — vault state is in-memory only, should re-lock
    await page.reload();

    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  });
});

/**
 * Lockout test uses a dedicated user to avoid contaminating other specs.
 * After 5 failed attempts, the account should be locked.
 */
test.describe("Vault Lockout", () => {
  test("lockout after 5 failed attempts", async ({ context, page }) => {
    const { lockout } = getAuthState();
    await injectSession(context, lockout.sessionToken);

    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    // Attempt 5 wrong passphrases
    for (let i = 0; i < 5; i++) {
      await lockPage.unlock(`wrong-pass-${i}`);
      // Wait for error to appear before retrying
      await expect(lockPage.errorMessage).toBeVisible({ timeout: 10_000 });
      // Clear for next attempt
      await lockPage.passphraseInput.clear();
    }

    // 6th attempt should show lockout message
    await lockPage.unlock("another-wrong");
    await expect(lockPage.errorMessage).toContainText(
      /locked|ロック/i,
      { timeout: 10_000 }
    );
  });
});
