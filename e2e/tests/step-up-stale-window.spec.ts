import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { makeSessionStale, refreshSessionRecency } from "../helpers/db";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";
import { TrashPage } from "../page-objects/trash.page";

/**
 * Step-up client reauth on a STALE window (companion to trash.spec.ts, which
 * runs empty-trash on a REFRESHED session). Here the session is deliberately
 * pushed outside the 15-minute step-up window so the empty-trash mutation
 * returns SESSION_STEP_UP_REQUIRED; the client must open the reauth prompt
 * instead of silently reloading. The seeded user has no passkey, so the
 * RecentSessionRequiredDialog (sign-in-again) path is exercised.
 */
test.describe("Step-up reauth on stale window", () => {
  let context: BrowserContext;
  let page: Page;

  const ts = Date.now();
  const entryTitle = `E2E StaleStepUp ${ts}`;

  test.beforeAll(async ({ browser }) => {
    const { vaultReady } = getAuthState();
    context = await browser.newContext();
    await injectSession(context, vaultReady.sessionToken);
    page = await context.newPage();

    await page.goto("/ja/dashboard");
    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 20_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Create one entry and move it to trash so empty-trash has something to do.
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);
    await dashboard.createNewPassword();
    await entryPage.fill({ title: entryTitle, password: "E2EStaleP@ss1" });
    await entryPage.save();
    await expect(dashboard.entryByTitle(entryTitle)).toBeVisible({ timeout: 10_000 });

    // Move it to trash (soft-delete) so empty-trash has something to purge.
    await entryPage.deleteEntry(entryTitle);
  });

  test.afterAll(async () => {
    // This spec mutates the SHARED vaultReady session (makeSessionStale). Restore
    // its recency so a later-ordered spec reusing this session isn't left stale.
    const { vaultReady } = getAuthState();
    await refreshSessionRecency(vaultReady.sessionToken);
    await context.close();
  });

  test("empty-trash on a stale session opens the reauth prompt", async () => {
    const { vaultReady } = getAuthState();
    const sidebar = new SidebarNavPage(page);
    const trashPage = new TrashPage(page);

    await sidebar.navigateTo("trash");
    await expect(page.getByText(entryTitle)).toBeVisible({ timeout: 10_000 });

    // Push the session outside the step-up window so empty-trash returns 403.
    await makeSessionStale(vaultReady.sessionToken);

    // Click "Empty Trash" and confirm; the mutation now 403s.
    await trashPage.emptyTrashButton.click();
    await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
    await trashPage.emptyTrashConfirmButton.click();

    // The reauth prompt (sign-in-again) must appear — NOT a silent reload.
    await expect(
      page.getByText(/Sign in again to continue|続行するには再サインインが必要です/),
    ).toBeVisible({ timeout: 10_000 });

    // And the trashed entry must still be present (the purge was blocked).
    await expect(page.getByText(entryTitle)).toBeVisible();
  });
});
