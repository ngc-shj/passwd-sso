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
    await page.goto("/ja/dashboard");

    // Wait for page to load
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    // Click language switcher (Globe icon button)
    const globeButton = page
      .locator("header")
      .getByRole("button")
      .filter({ has: page.locator("svg") })
      .first();
    await globeButton.click();

    // Select English
    const enOption = page.getByRole("menuitem", { name: /English/i });
    await enOption.click();

    // URL should change to /en/
    await expect(page).toHaveURL(/\/en\/dashboard/);

    // UI should be in English
    await expect(
      page.getByRole("button", { name: /Unlock/i })
    ).toBeVisible();
  });

  test("switch from en to ja", async ({ page }) => {
    await page.goto("/en/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    const globeButton = page
      .locator("header")
      .getByRole("button")
      .filter({ has: page.locator("svg") })
      .first();
    await globeButton.click();

    const jaOption = page.getByRole("menuitem", { name: /日本語/i });
    await jaOption.click();

    await expect(page).toHaveURL(/\/ja\/dashboard/);
  });

  test("locale switch preserves vault unlocked state", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    // Unlock first
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Verify unlocked
    await expect(lockPage.passphraseInput).not.toBeVisible();

    // Switch locale
    const globeButton = page
      .locator("header")
      .getByRole("button")
      .filter({ has: page.locator("svg") })
      .first();
    await globeButton.click();

    const enOption = page.getByRole("menuitem", { name: /English/i });
    await enOption.click();

    await expect(page).toHaveURL(/\/en\/dashboard/);

    // Vault should still be unlocked (no lock screen)
    await expect(lockPage.passphraseInput).not.toBeVisible({ timeout: 5_000 });
  });
});
