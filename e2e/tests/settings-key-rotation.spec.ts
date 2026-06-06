import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { seedSession } from "../helpers/db";
import { resetRotationRateLimit } from "../helpers/redis";
import { VaultLockPage } from "../page-objects/vault-lock.page";
import { DashboardPage } from "../page-objects/dashboard.page";
import { PasswordEntryPage } from "../page-objects/password-entry.page";
import { SettingsPage } from "../page-objects/settings.page";

/**
 * Key Rotation test.
 *
 * Uses the dedicated `keyRotation` user (DESTRUCTIVE — rotates encryption key).
 * Creates a password entry before rotation and verifies it is still readable
 * after the key has been rotated.
 */
test("Key rotation preserves existing vault entries", async ({
  context,
  page,
}) => {
  // Rotation now does additional work (rotationEffects response, banner state,
  // toast checks) — the 30s default leaves no margin in CI. Bump to 60s
  // (confirmed sufficient for ~408 entries in dev DB; CI has fewer).
  test.setTimeout(60_000);
  const { keyRotation } = getAuthState();

  // Defense-in-depth: prior CI runs or other parallel tests in the same
  // 15-min window may have consumed budget. Reset upfront so this test
  // starts with a clean rate-limit quota even if invoked in isolation.
  await resetRotationRateLimit(keyRotation.id);

  await injectSession(context, keyRotation.sessionToken);
  await page.goto("/ja/dashboard");

  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 10_000 });
  await lockPage.unlockAndWait(keyRotation.passphrase!);

  const dashboard = new DashboardPage(page);
  const entryPage = new PasswordEntryPage(page);
  const settings = new SettingsPage(page);

  const testEntry = {
    title: `Key Rotation Test ${Date.now()}`,
    username: "rotation-user@example.com",
    password: "BeforeRotation!99",
  };

  await test.step("create a test password entry", async () => {
    await dashboard.createNewPassword();
    await entryPage.fill(testEntry);
    await entryPage.save();

    await expect(dashboard.entryByTitle(testEntry.title)).toBeVisible({
      timeout: 10_000,
    });
  });

  await test.step("navigate to Settings > Security (Key Rotation)", async () => {
    await settings.gotoKeyRotation();
    // Navigating to a new page resets React state; re-unlock the vault
    await lockPage.unlockAndWait(keyRotation.passphrase!);

    // The rotate key card should be visible
    await expect(
      page.getByRole("button", {
        name: /Rotate Key|キーをローテーション/i,
      })
    ).toBeVisible({ timeout: 5_000 });
  });

  await test.step("trigger key rotation", async () => {
    await page
      .getByRole("button", { name: /Rotate Key|キーをローテーション/i })
      .click();

    // Rotation dialog opens
    await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });

    // Enter passphrase to confirm
    await page.locator("#rk-passphrase").fill(keyRotation.passphrase!);

    await page
      .locator("[role='dialog']")
      .getByRole("button", {
        name: /Rotate Key|キーをローテーション/i,
      })
      .click();

    // Wait for the dialog to close (rotation completes)
    await page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 120_000,
    });
  });

  await test.step("verify test entry is still accessible after rotation", async () => {
    // #433/S-N2: rotation now invalidates ALL user-bound sessions (incl. the
    // one driving this test). The cookie is still in the browser context but
    // the DB row was deleted. Re-seed with the same token (UPSERT) so the
    // post-rotation navigation can authenticate. The cookie value is unchanged
    // — production users sign in again here; tests just shortcut the re-auth.
    await seedSession(keyRotation.id, keyRotation.sessionToken);

    await page.goto("/ja/dashboard");

    // Full page navigation resets React state; re-unlock with the same passphrase
    // (key rotation keeps the passphrase unchanged — only the derived key is rotated)
    await lockPage.unlockAndWait(keyRotation.passphrase!);

    // Entry should still appear in the list
    await expect(dashboard.entryByTitle(testEntry.title)).toBeVisible({
      timeout: 10_000,
    });

    // Click to expand inline detail — decrypted data should be visible.
    // master-detail shows the username in both the list row and the detail pane.
    await dashboard.entryByTitle(testEntry.title).click();
    await expect(page.getByText(testEntry.username).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});

/**
 * Phase B (#437): rotation auto-migrates legacy mode-0 attachments to mode-2
 * (CEK indirection) before committing the key rotation. The ack gate is gone;
 * rotation must succeed without any user confirmation step.
 *
 * Scope (Option A): this test verifies the Phase A acknowledge UI is gone and
 * rotation completes without a data-loss prompt. It does NOT seed mode-0
 * legacy attachments — direct DB injection of mode-0 rows produces undecryptable
 * random ciphertext, which the client rotation flow correctly rejects (the
 * migrate path requires real plaintext to round-trip through user's vault key,
 * but the vault CryptoKey lives in the browser and is not accessible from
 * Playwright node context). The mode-0 → mode-2 migration logic itself, plus
 * the per-iteration cek_key_version assertion, are owned by integration tests
 * (vault-rotate-key-attachments.integration.test.ts T12.1 / T12.2 / T12.5c).
 */
test("Key rotation succeeds without the Phase A acknowledge step", async ({
  context,
  page,
}) => {
  // Single rotation round-trip, but the user accumulates entries from the
  // first test in this file. 120s covers the dialog's own waitFor budget.
  test.setTimeout(120_000);

  const { keyRotation } = getAuthState();

  // The previous test ("preserves existing vault entries") rotates this same
  // user, which revokes the global-setup session per #433/S-N2. Re-seed
  // (UPSERT) so this test starts from a valid auth state regardless of order.
  await seedSession(keyRotation.id, keyRotation.sessionToken);

  // Reset rate-limit so prior test's rotation hits do not bleed into this one.
  await resetRotationRateLimit(keyRotation.id);

  await injectSession(context, keyRotation.sessionToken);
  await page.goto("/ja/dashboard");

  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 20_000 });
  await lockPage.unlockAndWait(keyRotation.passphrase!);

  const settings = new SettingsPage(page);

  await test.step("rotation dialog has no ack button (Phase A artifact removed)", async () => {
    await settings.gotoKeyRotation();
    await lockPage.unlockAndWait(keyRotation.passphrase!);

    await page
      .getByRole("button", { name: /Rotate Key|キーをローテーション/i })
      .click();

    await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });

    // Phase A's "Acknowledge data loss and rotate" button is gone.
    await expect(
      page.locator("[role='dialog']").getByRole("button", {
        name: /acknowledge|データ損失/i,
      }),
    ).toHaveCount(0);

    await page.locator("#rk-passphrase").fill(keyRotation.passphrase!);
    await page
      .locator("[role='dialog']")
      .getByRole("button", { name: /Rotate Key|キーをローテーション/i })
      .click();

    // Rotation completes (no mode-0 to migrate; this user has only entries
    // accumulated by prior tests, all of which rotate cleanly).
    await page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 60_000,
    });
  });
});
