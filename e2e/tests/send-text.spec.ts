import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { ShareLinksPage } from "../page-objects/share-links.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

const SEND_NAME = `E2E Text Send ${Date.now()}`;
const SEND_CONTENT = "This is a secret E2E test message.\nLine two here.";

test.describe("Text Send", () => {
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

  test("create text send and access content without auth", async ({ browser }) => {
    const shareLinksPage = new ShareLinksPage(page);
    let sendUrl: string;

    await test.step("navigate to share-links page", async () => {
      const sidebar = new SidebarNavPage(page);
      await sidebar.navigateTo("shareLinks");
      await expect(
        page.getByRole("button", { name: /New Send|新規Send|新規送信/i })
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("open send dialog and create text send", async () => {
      await shareLinksPage.newSendButton.click();

      // SendDialog should open
      await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });

      // Fill in the name field
      await page
        .locator("[role='dialog']")
        .getByRole("textbox")
        .first()
        .fill(SEND_NAME);

      // Make sure we're on the Text tab (default)
      await page
        .getByRole("tab", { name: /^Text$|^テキスト$/i })
        .click();

      // Fill in the text content (textarea)
      await page.locator("[role='dialog'] textarea").fill(SEND_CONTENT);

      // Click Create
      await page
        .locator("[role='dialog']")
        .getByRole("button", { name: /Create Link|リンクを作成/i })
        .click();

      // The URL input should appear after creation
      const urlInput = page.locator("[role='dialog'] input[readonly]").first();
      await expect(urlInput).toBeVisible({ timeout: 15_000 });

      sendUrl = (await urlInput.inputValue()).trim();
      expect(sendUrl).toMatch(/^https?:\/\//);
    });

    await test.step("close send dialog", async () => {
      await page.keyboard.press("Escape");
      await page
        .locator("[role='dialog']")
        .waitFor({ state: "hidden", timeout: 5_000 });
    });

    await test.step("open send URL in unauthenticated context", async () => {
      const publicContext = await browser.newContext();
      const publicPage = await publicContext.newPage();

      await publicPage.goto(sendUrl);

      // Should display the send name as the heading
      await expect(publicPage.getByText(SEND_NAME)).toBeVisible({
        timeout: 15_000,
      });

      // Should display the text content
      await expect(
        publicPage.locator("pre").filter({ hasText: "E2E test message" })
      ).toBeVisible({ timeout: 10_000 });

      await publicContext.close();
    });

    await test.step("send appears in share-links list", async () => {
      // Navigate away and back via sidebar to trigger a list refresh without
      // a full page reload (which would re-lock the vault).
      const sidebar = new SidebarNavPage(page);
      await sidebar.navigateTo("passwords");
      await sidebar.navigateTo("shareLinks");

      // Wait for the list to finish loading before applying the filter
      await expect(page.locator(".animate-spin")).not.toBeVisible({ timeout: 10_000 });

      // Filter to sends only
      await shareLinksPage.filterByType("send");

      // The send name should appear in the list
      await expect(page.getByText(SEND_NAME)).toBeVisible({ timeout: 10_000 });
    });
  });
});
