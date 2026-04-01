import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

test.describe("Tags", () => {
  let context: BrowserContext;
  let page: Page;

  const ts = Date.now();
  const tagName = `e2e-tag-${ts}`;
  const entryTitle = `E2E Tagged Entry ${ts}`;

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

  test("create a tag via the entry form tag input", async () => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    // Open new entry dialog
    await dashboard.createNewPassword();

    // Fill in title and password (password is required for form submission)
    await entryPage.fill({ title: entryTitle, password: "E2eTagP@ss1!" });

    // Open tag input dropdown and create a new tag
    await page.getByRole("button", { name: /Add tag|タグを追加/i }).click();
    const tagInput = page.getByPlaceholder(/Search or create tag|検索または作成/i);
    await tagInput.fill(tagName);

    // Click "Create" option that appears
    await page.getByRole("button", { name: new RegExp(tagName) }).click();

    // Tag badge should appear in selected tags area
    await expect(page.getByText(tagName)).toBeVisible({ timeout: 5_000 });

    // Save the entry
    await entryPage.save();

    await expect(dashboard.entryByTitle(entryTitle)).toBeVisible({ timeout: 10_000 });
  });

  test("entry appears in tag filtered view via sidebar", async () => {
    // The tag should now appear in the sidebar under the Tags section.
    // Expand the Tags section first (it is collapsed by default).
    const sidebar = new SidebarNavPage(page);
    await sidebar.expandTagsSection();

    // Click the tag link in the sidebar to filter by it.
    const tagLink = page.getByRole("link", { name: tagName });
    await tagLink.click();

    // URL should contain /tags/
    await expect(page).toHaveURL(/\/tags\//, { timeout: 10_000 });

    // The tagged entry should be visible
    await expect(page.getByText(entryTitle)).toBeVisible({ timeout: 10_000 });
  });
});
