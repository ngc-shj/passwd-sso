/**
 * E2E: IA redirect rules — old settings URLs redirect to new locations.
 *
 * Each IA_REDIRECT entry is tested for every supported locale.
 * The 308 is followed automatically by the browser; we assert the final URL
 * and that the MovedPageNotice is visible on first arrival.
 *
 * sessionStorage scope is also verified:
 *   - Same context: notice disappears after navigating away and back.
 *   - New context: notice reappears (sessionStorage is per-context).
 */

import { test, expect } from "@playwright/test";
import { IA_REDIRECTS } from "@/lib/redirects/ia-redirects";
import { LOCALES } from "@/i18n/locales";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";

// MovedPageNotice renders the title key "movedNotice.title" as a <span>.
// Match both locales without importing translation files in E2E.
const MOVED_NOTICE_TITLE_PATTERN = /ページが移動しました|This page moved/;

for (const locale of LOCALES) {
  for (const { from, to } of IA_REDIRECTS) {
    test(`[${locale}] ${from} → ${to}`, async ({ page, context }) => {
      const { vaultReady } = getAuthState();
      await injectSession(context, vaultReady.sessionToken);

      await page.goto(`/${locale}${from}`);

      // 308 followed automatically — verify the final URL
      await expect(page).toHaveURL(new RegExp(`/${locale}${to}$`));

      // MovedPageNotice is rendered on first arrival (amber banner with title)
      await expect(page.getByText(MOVED_NOTICE_TITLE_PATTERN).first()).toBeVisible({
        timeout: 10_000,
      });
    });
  }
}

test.describe("MovedPageNotice sessionStorage scope", () => {
  const locale = "ja";
  // Use the first redirect as the representative case
  const redirect = IA_REDIRECTS[0];

  test("notice hidden after navigating away and back in the same context", async ({
    page,
    context,
  }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);

    // First arrival via old URL — notice should be visible
    await page.goto(`/${locale}${redirect.from}`);
    await expect(page).toHaveURL(new RegExp(`/${locale}${redirect.to}$`));
    await expect(page.getByText(MOVED_NOTICE_TITLE_PATTERN).first()).toBeVisible({
      timeout: 10_000,
    });

    // Navigate away — unmount records dismissal in sessionStorage
    await page.goto(`/${locale}/dashboard`);

    // Navigate back to the destination directly
    await page.goto(`/${locale}${redirect.to}`);

    // Notice must not re-appear (sessionStorage gate)
    await expect(page.getByText(MOVED_NOTICE_TITLE_PATTERN).first()).not.toBeVisible({
      timeout: 5_000,
    });
  });

  test("notice visible again in a new context (sessionStorage is per-device)", async ({
    browser,
  }) => {
    const { vaultReady } = getAuthState();

    // Fresh context = fresh sessionStorage
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await injectSession(ctx, vaultReady.sessionToken);

    await pg.goto(`/${locale}${redirect.from}`);
    await expect(pg).toHaveURL(new RegExp(`/${locale}${redirect.to}$`));
    await expect(pg.getByText(MOVED_NOTICE_TITLE_PATTERN).first()).toBeVisible({
      timeout: 10_000,
    });

    await ctx.close();
  });
});
