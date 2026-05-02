/**
 * E2E: MigrationBanner — one-time upgrade notice for the IA redesign.
 *
 * Tests:
 *   - First visit (no localStorage): banner is shown.
 *   - Click dismiss → localStorage key set; banner hidden.
 *   - Reload same context → banner stays hidden.
 *   - New context → banner shown again (localStorage is per-device).
 *   - Sunset: advancing clock past BANNER_SUNSET_TS hides the banner.
 */

import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { BANNER_DISMISS_KEY, BANNER_SUNSET_TS } from "@/components/settings/migration-banner-config";

const BANNER_TITLE_PATTERN = /個人の設定の構成を改善しました|Personal settings layout updated/;
const DISMISS_BUTTON_PATTERN = /了解|Got it/;

async function gotoUnlockedDashboard(
  page: import("@playwright/test").Page,
  locale: string,
  passphrase: string,
): Promise<void> {
  await page.goto(`/${locale}/dashboard`);
  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  await lockPage.unlockAndWait(passphrase);
}

test.describe("MigrationBanner", () => {
  test("shown on first visit when localStorage has no dismiss key", async ({
    page,
    context,
  }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await gotoUnlockedDashboard(page, "ja", vaultReady.passphrase!);

    await expect(page.getByText(BANNER_TITLE_PATTERN).first()).toBeVisible({ timeout: 5_000 });
  });

  test("dismiss sets localStorage key and hides the banner", async ({ page, context }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await gotoUnlockedDashboard(page, "ja", vaultReady.passphrase!);

    await expect(page.getByText(BANNER_TITLE_PATTERN).first()).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: DISMISS_BUTTON_PATTERN }).click();

    // Banner disappears immediately
    await expect(page.getByText(BANNER_TITLE_PATTERN).first()).not.toBeVisible({
      timeout: 3_000,
    });

    // localStorage key must be set
    const value = await page.evaluate((key: string) => localStorage.getItem(key), BANNER_DISMISS_KEY);
    expect(value).not.toBeNull();
  });

  test("banner stays hidden after reload in the same context", async ({ page, context }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await gotoUnlockedDashboard(page, "ja", vaultReady.passphrase!);

    await expect(page.getByText(BANNER_TITLE_PATTERN).first()).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: DISMISS_BUTTON_PATTERN }).click();
    await expect(page.getByText(BANNER_TITLE_PATTERN).first()).not.toBeVisible({ timeout: 3_000 });

    // Reload and unlock again
    await gotoUnlockedDashboard(page, "ja", vaultReady.passphrase!);

    // Banner must remain hidden
    await expect(page.getByText(BANNER_TITLE_PATTERN).first()).not.toBeVisible({ timeout: 3_000 });
  });

  test("banner visible again in a new context (localStorage is per-device)", async ({
    browser,
  }) => {
    const { vaultReady } = getAuthState();

    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await injectSession(ctx, vaultReady.sessionToken);
    await gotoUnlockedDashboard(pg, "ja", vaultReady.passphrase!);

    await expect(pg.getByText(BANNER_TITLE_PATTERN).first()).toBeVisible({ timeout: 5_000 });

    await ctx.close();
  });

  test("banner hidden when clock is past BANNER_SUNSET_TS", async ({ page, context }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);

    // Install a fake clock past the sunset timestamp before navigating
    // so the component's isSunset() check returns true on mount.
    await page.clock.install({ time: BANNER_SUNSET_TS.getTime() + 1 });

    await gotoUnlockedDashboard(page, "ja", vaultReady.passphrase!);

    // Banner must not appear when past sunset
    await expect(page.getByText(BANNER_TITLE_PATTERN).first()).not.toBeVisible({
      timeout: 5_000,
    });
  });
});
