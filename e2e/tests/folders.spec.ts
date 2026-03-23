import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

test.describe("Folders", () => {
  let context: BrowserContext;
  let page: Page;

  const ts = Date.now();
  const folderName = `E2E Folder ${ts}`;
  const entryTitle = `E2E Folder Entry ${ts}`;

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

  test("create a folder via the sidebar Manage section", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.createFolder(folderName);

    // The new folder should appear in the sidebar
    await expect(page.getByRole("link", { name: folderName })).toBeVisible({ timeout: 5_000 });
  });

  test("create an entry assigned to the folder", async () => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    await dashboard.createNewPassword();
    await entryPage.fill({ title: entryTitle });

    // Assign to the folder using the folder select dropdown
    const folderSelect = page.getByRole("combobox");
    await folderSelect.click();
    await page.getByRole("option", { name: folderName }).click();

    await entryPage.save();
    await expect(dashboard.entryByTitle(entryTitle)).toBeVisible({ timeout: 10_000 });
  });

  test("entry appears in folder filtered view via sidebar", async () => {
    // Click the folder link in the sidebar
    const folderLink = page.getByRole("link", { name: folderName });
    await folderLink.click();
    await page.waitForLoadState("networkidle");

    // URL should contain /folders/
    await expect(page).toHaveURL(/\/folders\//);

    // The entry assigned to the folder should be visible
    await expect(page.getByText(entryTitle)).toBeVisible({ timeout: 10_000 });
  });
});
