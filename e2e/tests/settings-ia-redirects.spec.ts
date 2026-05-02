/**
 * E2E: IA redirect rules — old settings URLs redirect to new locations.
 *
 * Each IA_REDIRECT entry is tested for every supported locale.
 * The 308 is followed automatically by the browser; we assert the final URL.
 */

import { test, expect } from "@playwright/test";
import { IA_REDIRECTS } from "@/lib/redirects/ia-redirects";
import { LOCALES } from "@/i18n/locales";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";

for (const locale of LOCALES) {
  for (const { from, to } of IA_REDIRECTS) {
    test(`[${locale}] ${from} → ${to}`, async ({ page, context }) => {
      const { vaultReady } = getAuthState();
      await injectSession(context, vaultReady.sessionToken);

      await page.goto(`/${locale}${from}`);

      // 308 followed automatically — verify the final URL
      await expect(page).toHaveURL(new RegExp(`/${locale}${to}$`));
    });
  }
}
