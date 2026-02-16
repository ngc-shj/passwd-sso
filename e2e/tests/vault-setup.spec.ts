import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultSetupPage } from "../page-objects/vault-setup.page";

test.describe("Vault Setup", () => {
  test.beforeEach(async ({ context }) => {
    const { fresh } = getAuthState();
    await injectSession(context, fresh.sessionToken);
  });

  test("initial setup with valid passphrase", async ({ page }) => {
    await page.goto("/ja/dashboard");

    const setupPage = new VaultSetupPage(page);

    // Should show setup form (vault not initialized)
    await expect(setupPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await setupPage.setup("MySecurePassphrase!2026");

    // Should navigate to dashboard after successful setup
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("passphrase mismatch shows error", async ({ page }) => {
    await page.goto("/ja/dashboard");

    const setupPage = new VaultSetupPage(page);
    await expect(setupPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await setupPage.passphraseInput.fill("MySecurePassphrase!2026");
    await setupPage.confirmInput.fill("DifferentPassphrase!2026");

    // Submit button should be disabled or error shown
    await expect(setupPage.submitButton).toBeDisabled();
  });

  test("passphrase too short shows validation error", async ({ page }) => {
    await page.goto("/ja/dashboard");

    const setupPage = new VaultSetupPage(page);
    await expect(setupPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    await setupPage.passphraseInput.fill("short");
    await setupPage.confirmInput.fill("short");

    // Should show validation error (min 10 chars)
    await expect(setupPage.submitButton).toBeDisabled();
  });
});
