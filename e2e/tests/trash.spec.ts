import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";
import { TrashPage } from "../page-objects/trash.page";

test.describe("Trash", () => {
  let context: BrowserContext;
  let page: Page;

  const ts = Date.now();
  const entryTitle1 = `E2E Trash A ${ts}`;
  const entryTitle2 = `E2E Trash B ${ts}`;

  test.beforeAll(async ({ browser }) => {
    const { vaultReady } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, vaultReady.sessionToken);
    page = await context.newPage();

    await page.goto("/ja/dashboard");
    const lockPage = new VaultLockPage(page);
    // Use a generous timeout: vault status check can be slow when the server
    // is processing other requests (vault setup check → /api/vault/status).
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 20_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("create 2 entries and move both to trash", async () => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    // Create first entry
    await dashboard.createNewPassword();
    await entryPage.fill({ title: entryTitle1, password: "E2ETrashP@ss1" });
    await entryPage.save();
    await expect(dashboard.entryByTitle(entryTitle1)).toBeVisible({ timeout: 10_000 });

    // Create second entry
    await dashboard.createNewPassword();
    await entryPage.fill({ title: entryTitle2, password: "E2ETrashP@ss2" });
    await entryPage.save();
    await expect(dashboard.entryByTitle(entryTitle2)).toBeVisible({ timeout: 10_000 });

    // Move first entry to trash; wait for both the DELETE API response and the
    // subsequent GET /api/passwords re-fetch before touching the second entry.
    // Without this, the background re-fetch triggered by onDataChange can
    // destroy the dropdown mid-interaction (race between optimistic remove and
    // the async network call completing).
    const listRefreshAfterDelete = page.waitForResponse(
      (r) => /\/api\/passwords(?:[?#]|$)/.test(r.url()) && r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await entryPage.deleteEntry(entryTitle1);
    await expect(dashboard.entryByTitle(entryTitle1)).not.toBeVisible({ timeout: 10_000 });
    // Wait for the GET /api/passwords triggered by onDataChange to complete
    await listRefreshAfterDelete;

    // List is now fully settled — moreMenuButton must be visible and stable
    await expect(entryPage.moreMenuButton(entryTitle2)).toBeVisible({ timeout: 15_000 });

    // Move second entry to trash
    await entryPage.deleteEntry(entryTitle2);
    await expect(dashboard.entryByTitle(entryTitle2)).not.toBeVisible({ timeout: 10_000 });
  });

  test("both entries appear in /trash view", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("trash");

    await expect(page).toHaveURL(/\/trash/);
    await expect(page.getByText(entryTitle1)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(entryTitle2)).toBeVisible({ timeout: 10_000 });
  });

  test("restore one entry returns it to main list", async () => {
    const trashPage = new TrashPage(page);

    // Wait for the POST /restore and the subsequent GET /api/passwords?trash=true
    // re-fetch to complete before checking visibility.
    const restoreResponse = page.waitForResponse(
      (r) => r.url().includes("/restore") && r.request().method() === "POST",
      { timeout: 15_000 }
    );
    await trashPage.restoreEntry(entryTitle1);
    await restoreResponse;

    // It should disappear from trash
    await expect(page.getByText(entryTitle1)).not.toBeVisible({ timeout: 10_000 });

    // Navigate to main list and verify it's back
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("passwords");
    await expect(page.getByText(entryTitle1)).toBeVisible({ timeout: 10_000 });

    // Go back to trash — second entry still there
    await sidebar.navigateTo("trash");
    await expect(page.getByText(entryTitle2)).toBeVisible({ timeout: 10_000 });
  });

  test("empty trash permanently deletes remaining entries", async () => {
    const trashPage = new TrashPage(page);

    // Should be on /trash already — empty it
    await trashPage.emptyTrash();

    // Trash should now be empty (second entry gone)
    await expect(page.getByText(entryTitle2)).not.toBeVisible({ timeout: 10_000 });
  });
});
