import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

test.describe("Locale Switching", () => {
  test.beforeEach(async ({ context }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
  });

  test("switch from ja to en", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    // Lock screen has no header — unlock first
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Click language switcher (Globe icon button in header)
    await page.locator("header button:has(.lucide-globe)").click();

    // Select English
    await page.getByRole("menuitem", { name: /English/i }).click();

    // URL should change to /en/
    await expect(page).toHaveURL(/\/en\/dashboard/);
  });

  test("switch from en to ja", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/en/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    await page.locator("header button:has(.lucide-globe)").click();
    await page.getByRole("menuitem", { name: /日本語/i }).click();

    await expect(page).toHaveURL(/\/ja\/dashboard/);
  });

  test("locale switch resets vault to locked state", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    // Unlock first
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);
    await expect(lockPage.passphraseInput).not.toBeVisible();

    // Switch locale — causes full page navigation
    await page.locator("header button:has(.lucide-globe)").click();
    await page.getByRole("menuitem", { name: /English/i }).click();

    await expect(page).toHaveURL(/\/en\/dashboard/);

    // Vault key is in-memory only — locale switch resets it, lock screen returns
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  });
});
