import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

test.describe("Archive", () => {
  let context: BrowserContext;
  let page: Page;

  const entryTitle = `E2E Archive ${Date.now()}`;

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

  test("create a password entry", async () => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    await dashboard.createNewPassword();
    await entryPage.fill({ title: entryTitle, username: "archive-user@example.com" });
    await entryPage.save();

    await expect(dashboard.entryByTitle(entryTitle)).toBeVisible({ timeout: 10_000 });
  });

  test("archive the entry via ⋮ menu", async () => {
    const entryPage = new PasswordEntryPage(page);

    // Open ⋮ menu and click Archive
    await entryPage.moreMenuButton(entryTitle).click();
    await page.getByRole("menuitem", { name: /^Archive$|^アーカイブ$/i }).click();

    // Entry should disappear from main list
    await expect(page.getByText(entryTitle)).not.toBeVisible({ timeout: 10_000 });
  });

  test("archived entry appears in /archive view", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("archive");

    await expect(page).toHaveURL(/\/archive/);
    await expect(page.getByText(entryTitle)).toBeVisible({ timeout: 10_000 });
  });

  test("unarchive returns entry to main list", async () => {
    const entryPage = new PasswordEntryPage(page);

    // On archive view, click ⋮ menu and Unarchive
    await entryPage.moreMenuButton(entryTitle).click();
    await page.getByRole("menuitem", { name: /^Unarchive$|^アーカイブ解除$/i }).click();

    // Entry should disappear from archive view
    await expect(page.getByText(entryTitle)).not.toBeVisible({ timeout: 10_000 });

    // Navigate to main passwords view and verify it's back
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("passwords");
    await expect(page.getByText(entryTitle)).toBeVisible({ timeout: 10_000 });
  });
});
