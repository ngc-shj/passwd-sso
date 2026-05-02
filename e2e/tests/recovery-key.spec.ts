import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

const RECOVERY_KEY_LABEL = /回復キー|Recovery Key/i;

test.describe("Recovery Key", () => {
  test("generate recovery key from settings page", async ({ context, page }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    // Navigate directly to the settings page. The full `page.goto` re-mounts
    // VaultProvider, so the lock screen renders first; unlock there so the
    // page-level button (gated on UNLOCKED) becomes clickable.
    await page.goto("/ja/dashboard/settings/auth/recovery-key");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // The card has a button labelled "回復キー" / "Recovery Key" that opens
    // the RecoveryKeyDialog.
    await page
      .getByRole("button", { name: RECOVERY_KEY_LABEL })
      .first()
      .click();

    // Recovery Key dialog should open — enter passphrase
    const passphraseInput = page.locator("#rk-passphrase");
    await expect(passphraseInput).toBeVisible({ timeout: 5_000 });
    await passphraseInput.fill(vaultReady.passphrase!);

    // Click the in-dialog generate button (same label).  Scope to the
    // dialog so we don't re-click the page-level trigger.
    await page
      .locator("[role='dialog']")
      .getByRole("button", { name: RECOVERY_KEY_LABEL })
      .click();

    // Should display Base32 recovery key (XXXX-XXXX-... format)
    const keyDisplay = page.locator("code");
    await expect(keyDisplay).toBeVisible({ timeout: 15_000 });

    const keyText = await keyDisplay.textContent();
    expect(keyText).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}-[A-Z2-7]{2}$/);
  });

  test("invalid recovery key shows client-side error", async ({
    context,
    page,
  }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
    await page.goto("/ja/recovery");

    // Enter an invalid recovery key (bad checksum)
    const keyInput = page.locator("#recovery-key");
    await expect(keyInput).toBeVisible({ timeout: 10_000 });
    await keyInput.fill("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH");

    // Submit via form submit button
    await page.locator("button[type='submit']").click();

    // Should show error
    await expect(page.locator(".text-destructive")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("recovery key not set shows error", async ({ context, page }) => {
    // Use fresh user (no recovery key set)
    const { fresh } = getAuthState();
    await injectSession(context, fresh.sessionToken);
    await page.goto("/ja/recovery");

    const keyInput = page.locator("#recovery-key");
    await expect(keyInput).toBeVisible({ timeout: 10_000 });

    // Enter a syntactically valid but unregistered recovery key
    await keyInput.fill("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZAB-CDEF");

    await page.locator("button[type='submit']").click();

    // Should show error (recovery key not set or invalid)
    await expect(page.locator(".text-destructive")).toBeVisible({
      timeout: 10_000,
    });
  });
});
