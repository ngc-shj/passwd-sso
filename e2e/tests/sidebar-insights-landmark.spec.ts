/**
 * E2E: Sidebar InsightsSection aria-label landmark preservation.
 *
 * The InsightsSection wraps its contents in <section aria-label="Security">.
 * The English literal "Security" is intentionally kept even though the visible
 * label changed to "インサイト", so screen-reader users searching for "Security"
 * continue to find the section.
 *
 * This test verifies the landmark is present and visible on the dashboard
 * in both supported locales.
 */

import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

for (const locale of ["ja", "en"] as const) {
  test(`[${locale}] sidebar "Security" region landmark is visible on dashboard`, async ({
    page,
    context,
  }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);

    await page.goto(`/${locale}/dashboard`);

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // The section element uses aria-label="Security" (English literal) regardless
    // of locale — it is a screen-reader landmark, not a translated UI label.
    const securityRegion = page.getByRole("region", { name: "Security" });
    await expect(securityRegion).toBeVisible({ timeout: 5_000 });
  });
}
