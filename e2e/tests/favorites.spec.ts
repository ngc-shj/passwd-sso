import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { getAuthState } from "../helpers/fixtures";
import { injectSession } from "../helpers/auth";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SidebarNavPage } from "../page-objects/sidebar-nav.page";

test.describe("Favorites", () => {
  let context: BrowserContext;
  let page: Page;

  const entryTitle = `E2E Favorites ${Date.now()}`;

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

  test("create entry and toggle favorite via ⋮ menu", async () => {
    const dashboard = new DashboardPage(page);
    const entryPage = new PasswordEntryPage(page);

    await dashboard.createNewPassword();
    await entryPage.fill({ title: entryTitle, username: "fav-user@example.com", password: "E2eFavP@ss1!" });
    await entryPage.save();

    // Wait for the entry to appear in the list (dialog already closed by save())
    const card = entryPage.card(entryTitle);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The star button is the first button in the card (ChevronRight is a div, not a button).
    // Clicking it marks the entry as favorite.
    const starButton = card.getByRole("button").first();
    await starButton.click();

    // After clicking star, the star SVG gets fill-yellow-400 class
    await expect(card.locator("svg.fill-yellow-400")).toBeVisible({ timeout: 5_000 });
  });

  test("favorites view shows the favorited entry", async () => {
    const sidebar = new SidebarNavPage(page);
    await sidebar.navigateTo("favorites");

    await expect(page).toHaveURL(/\/favorites/);

    // Entry should appear in the favorites list
    await expect(page.getByText(entryTitle)).toBeVisible({ timeout: 10_000 });
  });

  test("unfavorite entry disappears from favorites view", async () => {
    // Already on /favorites — click star to unfavorite
    const entryPage = new PasswordEntryPage(page);
    const card = entryPage.card(entryTitle);
    // The star button is the first button in the card
    const starButton = card.getByRole("button").first();
    await starButton.click();

    // The entry should disappear from the favorites list
    await expect(page.getByText(entryTitle)).not.toBeVisible({ timeout: 10_000 });
  });
});
