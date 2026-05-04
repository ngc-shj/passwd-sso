import { test, expect } from "@playwright/test";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { getPool, seedSession } from "../helpers/db";
import { seedAttachment } from "../helpers/password-entry";
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

    // Click to expand inline detail — decrypted data should be visible
    await dashboard.entryByTitle(testEntry.title).click();
    await expect(page.getByText(testEntry.username)).toBeVisible({
      timeout: 10_000,
    });
  });
});

/**
 * Phase B (#437): rotation auto-migrates legacy mode-0 attachments to mode-2
 * (CEK indirection) before committing the key rotation. The ack gate is gone;
 * rotation must succeed without any user confirmation step.
 *
 * Attachment seeding: mode-0 placeholder row injected via seedAttachment()
 * (default encryptionMode: 0). The upload route now defaults to mode-2, so
 * direct DB injection is the only way to manufacture a mode-0 row in E2E.
 * No real-crypto plaintext is supplied — placeholder bytes are sufficient to
 * verify the migration path runs; end-to-end decryption of the migrated
 * attachment is covered by integration tests (C12 / T12.1).
 * (Option A: skip post-rotation DB decryption check; rationale: decryption of
 * real ciphertext requires the vault CryptoKey, which is not accessible from
 * Playwright node context. Integration tests own that coverage.)
 */
test("Key rotation auto-migrates legacy attachments and succeeds", async ({
  context,
  page,
}) => {
  // Single rotation round-trip, but the user accumulates entries from the
  // first test in this file. 120s covers the dialog's own waitFor budget.
  test.setTimeout(120_000);

  const { keyRotation } = getAuthState();
  const entryTitle = `Attach-Phase-B ${Date.now()}`;

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

  const dashboard = new DashboardPage(page);
  const entryPage = new PasswordEntryPage(page);
  const settings = new SettingsPage(page);

  // Create a real entry via the UI so the entry's encrypted blobs are valid.
  await test.step("create a host entry for the attachment", async () => {
    await dashboard.createNewPassword();
    await entryPage.fill({
      title: entryTitle,
      username: "attach-phase-b@example.com",
      password: "AttachPhaseBPassword!1",
    });
    await entryPage.save();
    await expect(dashboard.entryByTitle(entryTitle)).toBeVisible({
      timeout: 10_000,
    });
  });

  // Inject a mode-0 attachment directly in the DB (the upload route now
  // always produces mode-2; DB injection is the only E2E way to get mode-0).
  let entryId: string;
  let attachmentId: string;
  await test.step("seed a mode-0 attachment in the DB", async () => {
    const p = getPool();
    const r = await p.query<{ id: string }>(
      `SELECT id FROM password_entries
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [keyRotation.id],
    );
    if (r.rowCount === 0) throw new Error("Failed to find seeded entry id");
    entryId = r.rows[0].id;
    const result = await seedAttachment({
      passwordEntryId: entryId,
      createdById: keyRotation.id,
      encryptionMode: 0,
    });
    attachmentId = result.id;
  });

  await test.step("rotation completes without ack step", async () => {
    await settings.gotoKeyRotation();
    await lockPage.unlockAndWait(keyRotation.passphrase!);

    await page
      .getByRole("button", { name: /Rotate Key|キーをローテーション/i })
      .click();

    await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
    await page.locator("#rk-passphrase").fill(keyRotation.passphrase!);

    await page
      .locator("[role='dialog']")
      .getByRole("button", { name: /Rotate Key|キーをローテーション/i })
      .click();

    // Dialog closes on success — no ack button appears.
    await page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 120_000,
    });
  });

  await test.step("attachment row migrated to mode-2 in DB", async () => {
    // Verify the migration ran: the row must now be mode-2.
    // (Decryption of the ciphertext is covered by integration tests, not E2E.)
    const p = getPool();
    const r = await p.query<{ encryption_mode: number }>(
      `SELECT encryption_mode FROM attachments WHERE id = $1`,
      [attachmentId],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].encryption_mode).toBe(2);
  });
});
