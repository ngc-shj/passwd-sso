import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import Redis from "ioredis";
import { injectSession } from "../helpers/auth";
import { getAuthState } from "../helpers/fixtures";
import { getPool, seedSession } from "../helpers/db";
import { seedAttachment } from "../helpers/password-entry";

/**
 * Reset the per-user vault-rotation rate-limit key in Redis. The route uses
 * `rl:vault_rotate:${userId}` with windowMs=15min / max=3, shared between
 * GET /data and POST. Test 2 below makes two rotation round-trips
 * (rejected-without-ack + accepted-with-ack), each spending 2 hits — plus
 * test 1's prior rotation puts us over the 3-hit budget. Clearing the key
 * lets each test attempt run from a fresh quota.
 */
async function resetRotationRateLimit(userId: string): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const r = new Redis(url, { lazyConnect: true });
  try {
    await r.connect();
    await r.del(`rl:vault_rotate:${userId}`);
  } finally {
    r.disconnect();
  }
}
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
 * Rotation must surface the data-loss acknowledge step when personal-entry
 * attachments exist (#433 / A.4). The attachment row remains in the DB after
 * the user acknowledges — Phase B (issue #437) recovery flows depend on this.
 */
test("Key rotation requires explicit acknowledge when personal attachments exist", async ({
  context,
  page,
}) => {
  // 60s was insufficient (CI run 25283732238): the test does TWO rotation
  // round-trips (one rejected for missing ack, one accepted) on a user with
  // many existing entries from test 1 — re-encryption of 100+ entries plus
  // the second rotation's data fetch + tx pushes the test past 60s on CI.
  // Bump to 180s to match the dialog's own 120s waitFor budget plus headroom.
  test.setTimeout(180_000);

  const { keyRotation } = getAuthState();
  const attachmentId = randomUUID();
  const entryTitle = `Attach-Ack ${Date.now()}`;

  // The previous test ("preserves existing vault entries") rotates this same
  // user, which now revokes the global-setup session per #433/S-N2. Re-seed
  // (UPSERT) so this test starts from a valid auth state regardless of prior
  // test order.
  await seedSession(keyRotation.id, keyRotation.sessionToken);

  // Test 1 already burned 2 of the 3-per-15min rotation rate-limit hits for
  // this user; this test does TWO rotation round-trips of its own. Reset
  // upfront so the budget is per-test, not per-CI-window.
  await resetRotationRateLimit(keyRotation.id);

  await injectSession(context, keyRotation.sessionToken);
  await page.goto("/ja/dashboard");

  const lockPage = new VaultLockPage(page);
  await expect(lockPage.passphraseInput).toBeVisible({ timeout: 20_000 });
  await lockPage.unlockAndWait(keyRotation.passphrase!);

  const dashboard = new DashboardPage(page);
  const entryPage = new PasswordEntryPage(page);
  const settings = new SettingsPage(page);

  // Use the UI to create an entry — this guarantees the entry id is real
  // and the entry's encrypted blobs are valid for post-rotation checks.
  await test.step("create a host entry for the attachment", async () => {
    await dashboard.createNewPassword();
    await entryPage.fill({
      title: entryTitle,
      username: "attach-ack@example.com",
      password: "AttachAckPassword!1",
    });
    await entryPage.save();
    await expect(dashboard.entryByTitle(entryTitle)).toBeVisible({
      timeout: 10_000,
    });
  });

  // Resolve the entry id from the DB so we can attach to it.
  let entryId: string;
  await test.step("seed an attachment directly in the DB", async () => {
    const p = getPool();
    const r = await p.query<{ id: string }>(
      `SELECT id FROM password_entries
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [keyRotation.id],
    );
    if (r.rowCount === 0) throw new Error("Failed to find seeded entry id");
    entryId = r.rows[0].id;
    await seedAttachment({
      id: attachmentId,
      passwordEntryId: entryId,
      createdById: keyRotation.id,
    });
  });

  await test.step("rotation dialog surfaces ack step with attachment count", async () => {
    await settings.gotoKeyRotation();
    await lockPage.unlockAndWait(keyRotation.passphrase!);
    await page
      .getByRole("button", { name: /Rotate Key|キーをローテーション/i })
      .click();

    await page.locator("[role='dialog']").waitFor({ timeout: 5_000 });
    await page.locator("#rk-passphrase").fill(keyRotation.passphrase!);

    // Initial submit goes through; the data fetch returns attachmentsAffected > 0
    // and the dialog rejects with the ack step. The ack button is the only
    // way forward; the original submit becomes disabled.
    await page
      .locator("[role='dialog']")
      .getByRole("button", {
        name: /^Rotate Key$|^キーをローテーション$/i,
      })
      .click();

    await expect(
      page.getByRole("button", {
        name: /Acknowledge data loss and rotate|データ消失を承認してローテーション/i,
      }),
    ).toBeVisible({ timeout: 10_000 });
  });

  await test.step("acknowledge → rotation completes", async () => {
    // The rejected-without-ack attempt above consumed 2 rate-limit hits
    // (data fetch + POST). The next rotateKey() call also fetches /data and
    // POSTs — another 2 hits. Reset between attempts so the second rotation
    // is not 429'd. Production users do NOT need this because the dialog
    // gives them seconds between submit + acknowledge clicks; CI fires both
    // back-to-back inside the same rate-limit window.
    await resetRotationRateLimit(keyRotation.id);

    await page
      .getByRole("button", {
        name: /Acknowledge data loss and rotate|データ消失を承認してローテーション/i,
      })
      .click();

    await page.locator("[role='dialog']").waitFor({
      state: "hidden",
      timeout: 120_000,
    });
  });

  await test.step("attachment row remains in DB (Phase B recovery dependency)", async () => {
    const p = getPool();
    const r = await p.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM attachments WHERE id = $1`,
      [attachmentId],
    );
    // The orphan row stays — Phase A intentionally preserves it so the Phase B
    // recovery design (issue #437) has material to work with. Production code
    // surfaces the orphan as an undecryptable download.
    expect(r.rows[0].count).toBe("1");
  });
});
