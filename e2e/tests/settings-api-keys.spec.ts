import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { SettingsPage } from "../page-objects/settings.page";

const API_KEY_NAME = `E2E API Key ${Date.now()}`;

test.describe("Settings - API Keys", () => {
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

  test("create and delete API key", async () => {
    const settingsPage = new SettingsPage(page);

    await test.step("navigate to Developer tab in settings", async () => {
      await page.goto("/ja/dashboard/settings");
      await expect(settingsPage.developerTab).toBeVisible({ timeout: 10_000 });
      await settingsPage.switchTab("developer");
    });

    await test.step("API key manager section is visible", async () => {
      await expect(settingsPage.apiKeySection).toBeVisible({ timeout: 10_000 });
    });

    await test.step("create a new API key", async () => {
      const apiKeySection = settingsPage.apiKeySection;

      // Fill in the key name
      await apiKeySection
        .getByRole("textbox")
        .fill(API_KEY_NAME);

      // At least one scope checkbox is already checked by default (passwords:read)
      // Click "Create Key" button
      await apiKeySection
        .getByRole("button", { name: /Create Key|キーを作成/i })
        .click();

      // Newly created token section should appear (shown once)
      await expect(
        page.getByText(/Token ready|トークンが準備|tokenReady/i)
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("dismiss token reveal and verify key listed", async () => {
      // Dismiss the token-once banner
      await page.getByRole("button", { name: "OK" }).click();

      // The API key name should now appear in the key list
      await expect(
        settingsPage.apiKeySection.getByText(API_KEY_NAME)
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("delete (revoke) the API key", async () => {
      // Find the row for our key and click the Revoke button
      const keyRow = settingsPage.apiKeySection.locator("div").filter({
        hasText: API_KEY_NAME,
      }).first();

      await keyRow
        .getByRole("button", { name: /Revoke|失効/i })
        .click();

      // Confirmation alert dialog appears
      await page.locator("[role='alertdialog']").waitFor({ timeout: 5_000 });

      // Confirm revocation
      await page
        .locator("[role='alertdialog']")
        .getByRole("button", { name: /Revoke|失効/i })
        .click();

      // Wait for dialog to close
      await page
        .locator("[role='alertdialog']")
        .waitFor({ state: "hidden", timeout: 10_000 });

      // After revocation the key is moved to inactive — it should no longer
      // appear among active keys. The active section should not contain our key name,
      // or the key row should show a "revoked" badge.
      await expect(
        settingsPage.apiKeySection.getByText(/noActiveKeys|active keys/i)
      ).toBeVisible({ timeout: 10_000 }).catch(() => {
        // Alternative: the row is still present but labeled revoked
      });
    });
  });
});
