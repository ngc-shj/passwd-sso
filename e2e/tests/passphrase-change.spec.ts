import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

/**
 * Passphrase Change tests.
 *
 * Uses the dedicated `passphraseChange` user (DESTRUCTIVE).
 * The passphrase is permanently changed, so this test must not be retried
 * without resetting state first.
 */
test.describe.serial("Passphrase Change", () => {
  const NEW_PASSPHRASE = "E2E-NewPassphrase-2025!";

  test("change passphrase and re-unlock with new passphrase", async ({
    context,
    page,
  }) => {
    const { passphraseChange } = getAuthState();
    await injectSession(context, passphraseChange.sessionToken);
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(passphraseChange.passphrase!);

    await test.step("open Change Passphrase dialog from header menu", async () => {
      // Open the user avatar dropdown in the header
      await page.getByRole("button", { name: passphraseChange.name }).click();
      await page
        .getByRole("menuitem", { name: /Change Passphrase|パスフレーズを変更/i })
        .click();

      await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
    });

    await test.step("fill and submit the change passphrase form", async () => {
      await page.locator("#cp-current").fill(passphraseChange.passphrase!);
      await page.locator("#cp-new").fill(NEW_PASSPHRASE);
      await page.locator("#cp-confirm").fill(NEW_PASSPHRASE);

      await page
        .getByRole("button", {
          name: /Change Passphrase|パスフレーズを変更/i,
        })
        .click();

      // Dialog closes on success
      await page.locator("[role='dialog']").waitFor({
        state: "hidden",
        timeout: 20_000,
      });
    });

    await test.step("lock vault manually", async () => {
      await page.getByRole("button", { name: passphraseChange.name }).click();
      await page
        .getByRole("menuitem", { name: /Lock Vault|保管庫をロック/i })
        .click();

      // Vault lock screen should appear
      await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    });

    await test.step("unlock with new passphrase succeeds", async () => {
      await lockPage.unlockAndWait(NEW_PASSPHRASE);

      // After unlock the passphrase input disappears — dashboard is accessible
      await expect(lockPage.passphraseInput).not.toBeVisible({ timeout: 5_000 });
    });
  });

  test("old passphrase is rejected after change", async ({ context, page }) => {
    // This sub-test depends on the passphrase already having been changed by
    // the test above.  It verifies that the old credential is now invalid.
    const { passphraseChange } = getAuthState();
    await injectSession(context, passphraseChange.sessionToken);
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    // Attempt unlock with the original passphrase (should fail)
    await lockPage.unlock(passphraseChange.passphrase!);

    await expect(lockPage.errorMessage).toBeVisible({ timeout: 15_000 });
    // The unlock input remains visible (vault stays locked)
    await expect(lockPage.passphraseInput).toBeVisible();
  });
});
