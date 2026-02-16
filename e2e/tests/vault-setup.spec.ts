import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultSetupPage } from "../page-objects/vault-setup.page";

test.describe("Vault Setup", () => {
  test.beforeEach(async ({ context }) => {
    const { fresh } = getAuthState();
    await injectSession(context, fresh.sessionToken);
  });

  // Non-destructive tests first (they don't submit the form)
  test("passphrase mismatch keeps button disabled", async ({ page }) => {
    await page.goto("/ja/dashboard");

    const setupPage = new VaultSetupPage(page);
    await expect(setupPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await setupPage.passphraseInput.fill("MySecurePassphrase!2026");
    await setupPage.confirmInput.fill("DifferentPassphrase!2026");

    await expect(setupPage.submitButton).toBeDisabled();
  });

  test("passphrase too short keeps button disabled", async ({ page }) => {
    await page.goto("/ja/dashboard");

    const setupPage = new VaultSetupPage(page);
    await expect(setupPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await setupPage.passphraseInput.fill("short");
    await setupPage.confirmInput.fill("short");

    await expect(setupPage.submitButton).toBeDisabled();
  });

  // Destructive — sets up vault permanently for the fresh user
  test("initial setup with valid passphrase", async ({ page }) => {
    await page.goto("/ja/dashboard");

    const setupPage = new VaultSetupPage(page);
    await expect(setupPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await setupPage.setup("MySecurePassphrase!2026");

    // Should show dashboard after successful setup (URL already matches)
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
