/**
 * E2E: LockVaultButton — header icon button for one-click vault lock.
 *
 * Tests:
 *   - Unlocked vault: LockVaultButton is present in the header.
 *   - Click → vault locks → lock screen appears → URL unchanged.
 *   - Locked vault (after locking): button is no longer visible.
 *   - @mobile: same lock works with a single tap on iPhone 13 viewport.
 */

import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { VaultLockPage } from "../page-objects/vault-lock.page";

const LOCK_BUTTON_LABEL = /保管庫をロック|Lock Vault/;

test.describe("LockVaultButton (desktop)", () => {
  test.beforeEach(async ({ context }) => {
    const { vaultReady } = getAuthState();
    await injectSession(context, vaultReady.sessionToken);
  });

  test("header shows LockVaultButton when vault is unlocked", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // LockVaultButton must appear in the header
    const lockButton = page.locator("header").getByRole("button", { name: LOCK_BUTTON_LABEL });
    await expect(lockButton).toBeVisible();
  });

  test("clicking LockVaultButton locks the vault without navigating away", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    const urlBefore = page.url();

    // Click the lock button
    const lockButton = page.locator("header").getByRole("button", { name: LOCK_BUTTON_LABEL });
    await lockButton.click();

    // Lock screen must reappear
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    // Page URL must be unchanged (no redirect)
    expect(page.url()).toBe(urlBefore);
  });

  test("LockVaultButton is not visible when vault is locked", async ({ page }) => {
    const { vaultReady } = getAuthState();
    await page.goto("/ja/dashboard");

    const lockPage = new VaultLockPage(page);
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
    await lockPage.unlockAndWait(vaultReady.passphrase!);

    // Lock the vault via the button
    const lockButton = page.locator("header").getByRole("button", { name: LOCK_BUTTON_LABEL });
    await lockButton.click();
    await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });

    // Button must no longer be visible in the locked state
    await expect(
      page.locator("header").getByRole("button", { name: LOCK_BUTTON_LABEL }),
    ).not.toBeVisible();
  });
});

// @mobile — runs only under mobile-ios / mobile-android projects
test("@mobile: LockVaultButton locks vault in one tap", async ({ page, context }) => {
  const { vaultReady } = getAuthState();
  await injectSession(context, vaultReady.sessionToken);
  await page.goto("/ja/dashboard");

  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  await lockPage.unlockAndWait(vaultReady.passphrase!);

  // On mobile the button is still in the header — tap it
  const lockButton = page.locator("header").getByRole("button", { name: LOCK_BUTTON_LABEL });
  await expect(lockButton).toBeVisible();
  await lockButton.tap();

  // Lock screen must appear
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
});
