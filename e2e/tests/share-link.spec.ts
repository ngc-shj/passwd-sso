import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";

const TEST_ENTRY = {
  title: `E2E Share Test ${Date.now()}`,
  username: "share-test@example.com",
  password: "ShareTestPassword!456",
  url: "https://share-e2e.example.com",
};

test.describe("Share Link", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const { vaultReady } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, vaultReady.sessionToken);
    page = await context.newPage();
    await page.goto("/ja/dashboard");
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("create share link and access content without auth", async ({ browser }) => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    // Step 1: Create a password entry to share
    await test.step("create a password entry", async () => {
      await dashboard.createNewPassword();
      await entryPage.fill(TEST_ENTRY);
      await entryPage.save();
      await expect(dashboard.entryByTitle(TEST_ENTRY.title)).toBeVisible({
        timeout: 10_000,
      });
    });

    let shareUrl: string;

    await test.step("open share dialog from the entry menu", async () => {
      // Click card to expand inline details
      const entry = dashboard.entryByTitle(TEST_ENTRY.title);
      await entry.click();
      await expect(page.getByText(TEST_ENTRY.username)).toBeVisible({
        timeout: 10_000,
      });

      // Open ⋮ menu and click "Share Link"
      await entryPage.moreMenuButton(TEST_ENTRY.title).click();
      await page
        .getByRole("menuitem", { name: /Share Link|リンクで共有/i })
        .click();

      // Share dialog should open
      await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
    });

    await test.step("create share link with 1-day expiry", async () => {
      // Default expiry is already "1d"; click "Create Link"
      await page
        .getByRole("button", { name: /Create Link|リンクを作成/i })
        .click();

      // The URL input should appear after creation
      const urlInput = page.locator("[role='dialog'] input[readonly]").first();
      await expect(urlInput).toBeVisible({ timeout: 15_000 });

      shareUrl = (await urlInput.inputValue()).trim();
      expect(shareUrl).toMatch(/^https?:\/\//);
    });

    await test.step("close share dialog", async () => {
      await page.keyboard.press("Escape");
      await page
        .locator("[role='dialog']")
        .waitFor({ state: "hidden", timeout: 5_000 });
    });

    await test.step("open share link in unauthenticated context", async () => {
      const publicContext = await browser.newContext();
      const publicPage = await publicContext.newPage();

      // Share URL from the dialog may include a hash fragment
      await publicPage.goto(shareUrl);

      // Should display the title of the shared entry
      await expect(publicPage.getByText(TEST_ENTRY.title)).toBeVisible({
        timeout: 15_000,
      });

      // Should display the username field
      await expect(
        publicPage.getByText(TEST_ENTRY.username)
      ).toBeVisible({ timeout: 10_000 });

      await publicContext.close();
    });
  });
});
