import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { SettingsPage } from "../page-objects/settings.page";

test.describe("Settings - Travel Mode", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const { vaultReady } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, vaultReady.sessionToken);
    page = await context.newPage();
    await page.goto("/ja/dashboard");
    const lockPage = new VaultLockPage(page);
    await lockPage.unlockAndWait(vaultReady.passphrase!);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("enable and disable travel mode", async () => {
    const { vaultReady } = getAuthState();
    const settingsPage = new SettingsPage(page);
    const lockPage = new VaultLockPage(page);

    await test.step("navigate to Security settings page", async () => {
      await settingsPage.gotoSecurity();
      // Navigating to a new page resets React state; re-unlock the vault
      await lockPage.unlockAndWait(vaultReady.passphrase!);
    });

    await test.step("travel mode card is visible and inactive initially", async () => {
      await expect(settingsPage.travelModeCard).toBeVisible({ timeout: 10_000 });

      // Status should show "無効" (Inactive) before enabling
      // t("inactive") = "無効", t("status") = "ステータス"
      await expect(
        settingsPage.travelModeCard.getByText(/Inactive|無効/i)
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("enable travel mode", async () => {
      // t("enable") = "トラベルモードを有効化"
      await settingsPage.travelModeCard
        .getByRole("button", { name: /Enable|トラベルモードを有効化|有効化/i })
        .click();

      // Confirmation AlertDialog should appear
      await page.locator("[role='alertdialog']").waitFor({ timeout: 5_000 });

      // Confirm enable — the AlertDialog confirm button
      await page
        .locator("[role='alertdialog']")
        .getByRole("button", { name: /Enable|有効化/i })
        .click();

      // Dialog closes; status should now show "有効" (Active)
      await page
        .locator("[role='alertdialog']")
        .waitFor({ state: "hidden", timeout: 10_000 });

      // t("active") = "有効"
      await expect(
        settingsPage.travelModeCard.getByText(/^Active$|^有効$/i)
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("disable travel mode with passphrase", async () => {
      // t("disable") = "トラベルモードを無効化"
      await settingsPage.travelModeCard
        .getByRole("button", { name: /Disable|トラベルモードを無効化|無効化/i })
        .click();

      // Passphrase dialog appears (regular Dialog, not AlertDialog)
      await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });

      // Fill in the passphrase
      await page.locator("#travel-passphrase").fill(vaultReady.passphrase!);

      // Click the Disable button inside the dialog
      await page
        .locator("[role='dialog']")
        .getByRole("button", { name: /Disable|無効化/i })
        .click();

      // Dialog should close on success
      await page
        .locator("[role='dialog']")
        .waitFor({ state: "hidden", timeout: 15_000 });

      // Status should revert to "無効" (Inactive)
      await expect(
        settingsPage.travelModeCard.getByText(/Inactive|無効/i)
      ).toBeVisible({ timeout: 10_000 });
    });
  });
});
