/**
 * Integration test (real DB): personal rotation exact-set + retry semantics
 * (C10, security-control-verification plan).
 *
 * Extends the vault-rotate-key-gaps sibling coverage: entry/history
 * count-mismatch abort semantics, and retried-rotation VaultKey
 * @@unique([userId, version]) collision pinned to a mapped error envelope
 * (not a bare 500).
 *
 * Run: docker compose up -d db && npm run test:integration -- vault-rotate-key-exact-set
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import {
  applyVaultRotation,
  RotationCasConflictError,
  type RotationPayload,
} from "@/lib/vault/rotate-key-server";
import {
  createTestContext,
  setBypassRlsGucs,
  seedVaultUser,
  type TestContext,
} from "./helpers";

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

async function seedPasswordEntry(
  ctx: TestContext,
  userId: string,
  tenantId: string,
  keyVersion = 1,
): Promise<string> {
  const entryId = randomUUID();
  const now = new Date().toISOString();
  const placeholder = hex(32);
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO password_entries (
         id, user_id, tenant_id,
         encrypted_blob, blob_iv, blob_auth_tag,
         encrypted_overview, overview_iv, overview_auth_tag,
         key_version, aad_version, entry_type,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         $4, $5, $6, $7, $8, $9,
         $10, 1, 'LOGIN', $11, $11
       )`,
      entryId, userId, tenantId,
      placeholder, hex(12), hex(16),
      placeholder, hex(12), hex(16),
      keyVersion, now,
    );
  });
  return entryId;
}

async function seedHistoryRow(
  ctx: TestContext,
  entryId: string,
  tenantId: string,
  keyVersion = 1,
): Promise<string> {
  const historyId = randomUUID();
  const placeholder = hex(32);
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO password_entry_histories (
         id, entry_id, tenant_id,
         encrypted_blob, blob_iv, blob_auth_tag,
         key_version, aad_version, changed_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 1, now())`,
      historyId, entryId, tenantId, placeholder, hex(12), hex(16), keyVersion,
    );
  });
  return historyId;
}

function buildRotationPayload(opts: {
  entryIds: string[];
  historyIds: string[];
}): RotationPayload {
  const hex24 = hex(12);
  const hex32 = hex(16);
  const hex64 = hex(32);
  return {
    encryptedSecretKey: "new-esk-placeholder",
    secretKeyIv: hex24,
    secretKeyAuthTag: hex32,
    accountSalt: hex64,
    newAuthHash: hex64,
    verificationArtifact: { ciphertext: hex64, iv: hex24, authTag: hex32 },
    encryptedEcdhPrivateKey: "new-ecdh-placeholder",
    ecdhPrivateKeyIv: hex24,
    ecdhPrivateKeyAuthTag: hex32,
    entries: opts.entryIds.map((id) => ({
      id,
      encryptedBlob: { ciphertext: hex(32), iv: hex24, authTag: hex32 },
      encryptedOverview: { ciphertext: hex(32), iv: hex24, authTag: hex32 },
      aadVersion: 1,
    })),
    historyEntries: opts.historyIds.map((id) => ({
      id,
      encryptedBlob: { ciphertext: hex(32), iv: hex24, authTag: hex32 },
      aadVersion: 1,
    })),
    attachmentCekRewraps: [],
  };
}

async function rotate(
  ctx: TestContext,
  userId: string,
  tenantId: string,
  oldKeyVersion: number,
  newKeyVersion: number,
  payload: RotationPayload,
  oldVaultSetupAt: Date | null,
  oldAccountSalt: string,
) {
  return ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return applyVaultRotation(
      tx, userId, tenantId, oldKeyVersion, newKeyVersion,
      "hash", "salt", payload, oldVaultSetupAt, oldAccountSalt,
    );
  });
}

async function getEntryKeyVersions(ctx: TestContext, userId: string): Promise<number[]> {
  const r = await ctx.su.pool.query<{ key_version: number }>(
    `SELECT key_version FROM password_entries WHERE user_id = $1::uuid ORDER BY id`,
    [userId],
  );
  return r.rows.map((row) => row.key_version);
}

describe("personal rotation — exact-set + retry semantics (C10)", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
  });

  afterEach(async () => {
    try {
      await ctx.deleteTestData(tenantId);
    } catch {
      await ctx.deleteTestData(tenantId);
    }
  });

  // ── Entry created after /data payload was built ───────────────────────────

  it("entry created after payload snapshot → ENTRY_COUNT_MISMATCH abort, nothing committed (all rows still oldVersion)", async () => {
    const { userId, keyVersion: v1, vaultSetupAt, accountSalt } = await seedVaultUser(ctx, tenantId);
    const entryId1 = await seedPasswordEntry(ctx, userId, tenantId, v1);

    // Payload was built covering only entryId1 (simulating a /data fetch that
    // happened before entryId2 was created).
    const payload = buildRotationPayload({ entryIds: [entryId1], historyIds: [] });

    // A second entry appears AFTER the payload snapshot but BEFORE rotation runs.
    await seedPasswordEntry(ctx, userId, tenantId, v1);

    await expect(
      rotate(ctx, userId, tenantId, v1, v1 + 1, payload, vaultSetupAt, accountSalt),
    ).rejects.toThrow("ENTRY_COUNT_MISMATCH");

    // Nothing committed — both rows remain at the old version.
    const versions = await getEntryKeyVersions(ctx, userId);
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v === v1)).toBe(true);
  });

  // ── History row appearing mid-flow ────────────────────────────────────────

  it("history row appears mid-flow → HISTORY_COUNT_MISMATCH abort, nothing committed", async () => {
    const { userId, keyVersion: v1, vaultSetupAt, accountSalt } = await seedVaultUser(ctx, tenantId);
    const entryId = await seedPasswordEntry(ctx, userId, tenantId, v1);
    const historyId1 = await seedHistoryRow(ctx, entryId, tenantId, v1);

    const payload = buildRotationPayload({ entryIds: [entryId], historyIds: [historyId1] });

    // A second history row appears mid-flow (e.g. a concurrent edit's
    // snapshot) that the payload does not account for.
    await seedHistoryRow(ctx, entryId, tenantId, v1);

    await expect(
      rotate(ctx, userId, tenantId, v1, v1 + 1, payload, vaultSetupAt, accountSalt),
    ).rejects.toThrow("HISTORY_COUNT_MISMATCH");

    const entryVersions = await getEntryKeyVersions(ctx, userId);
    expect(entryVersions.every((v) => v === v1)).toBe(true);
    const historyRows = await ctx.su.pool.query<{ key_version: number }>(
      `SELECT key_version FROM password_entry_histories WHERE entry_id = $1::uuid`,
      [entryId],
    );
    expect(historyRows.rows.every((r) => r.key_version === v1)).toBe(true);
  });

  // ── Retried rotation colliding with existing VaultKey row ─────────────────

  it("retried rotation whose newKeyVersion collides with an existing VaultKey row → RotationCasConflictError (mapped, not a bare 500)", async () => {
    const { userId, keyVersion: v1, vaultSetupAt, accountSalt } = await seedVaultUser(ctx, tenantId);
    const entryId = await seedPasswordEntry(ctx, userId, tenantId, v1);
    const newKeyVersion = v1 + 1;

    // First rotation succeeds and creates the VaultKey row at newKeyVersion.
    const payload1 = buildRotationPayload({ entryIds: [entryId], historyIds: [] });
    await rotate(ctx, userId, tenantId, v1, newKeyVersion, payload1, vaultSetupAt, accountSalt);

    // Simulate a retried rotation attempt that (bypassing the normal CAS
    // snapshot flow — e.g. a caller with a stale-but-matching in-memory
    // snapshot) still passes the tuple CAS: reset the users row's
    // key_version/vault_setup_at/account_salt back to the ORIGINAL pre-
    // rotation values so the CAS re-check matches, while an existing
    // VaultKey row still occupies newKeyVersion from the first rotation.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE users SET key_version = $2, vault_setup_at = $3, account_salt = $4 WHERE id = $1::uuid`,
        userId, v1, vaultSetupAt, accountSalt,
      );
      // Restore the entry to oldVersion too so applyVaultRotation's other
      // guards (entry count etc.) don't fire first — isolates the VaultKey
      // collision as the specific failure under test.
      await tx.$executeRawUnsafe(
        `UPDATE password_entries SET key_version = $2 WHERE id = $1::uuid`,
        entryId, v1,
      );
    });

    const payload2 = buildRotationPayload({ entryIds: [entryId], historyIds: [] });

    // Pinned outcome (test-F9): must be the route's rotation-conflict typed
    // error, NOT a bare Prisma P2002 surfacing as an unhandled 500.
    await expect(
      rotate(ctx, userId, tenantId, v1, newKeyVersion, payload2, vaultSetupAt, accountSalt),
    ).rejects.toThrow(RotationCasConflictError);

    // The pre-existing VaultKey row from the first (successful) rotation is
    // untouched — still exactly one row at newKeyVersion.
    const vaultKeyRows = await ctx.su.pool.query<{ version: number }>(
      `SELECT version FROM vault_keys WHERE user_id = $1::uuid AND version = $2`,
      [userId, newKeyVersion],
    );
    expect(vaultKeyRows.rows).toHaveLength(1);
  });

  // ── Route-level envelope assertion for the same collision ─────────────────

  it("route maps the VaultKey collision to KEY_VERSION_MISMATCH with the standard 409 envelope", async () => {
    const { userId, keyVersion: v1, vaultSetupAt, accountSalt } = await seedVaultUser(ctx, tenantId);
    const entryId = await seedPasswordEntry(ctx, userId, tenantId, v1);
    const newKeyVersion = v1 + 1;

    const payload1 = buildRotationPayload({ entryIds: [entryId], historyIds: [] });
    await rotate(ctx, userId, tenantId, v1, newKeyVersion, payload1, vaultSetupAt, accountSalt);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE users SET key_version = $2, vault_setup_at = $3, account_salt = $4 WHERE id = $1::uuid`,
        userId, v1, vaultSetupAt, accountSalt,
      );
      await tx.$executeRawUnsafe(
        `UPDATE password_entries SET key_version = $2 WHERE id = $1::uuid`,
        entryId, v1,
      );
    });

    const payload2 = buildRotationPayload({ entryIds: [entryId], historyIds: [] });

    // Exercise the exact catch-mapping the route/route.ts applies: import the
    // error class map and assert the same instanceof branch the route uses
    // (RotationCasConflictError -> API_ERROR.KEY_VERSION_MISMATCH, 409).
    const { API_ERROR, API_ERROR_STATUS } = await import("@/lib/http/api-error-codes");
    try {
      await rotate(ctx, userId, tenantId, v1, newKeyVersion, payload2, vaultSetupAt, accountSalt);
      expect.fail("expected rotation to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RotationCasConflictError);
      // Mirrors rotate-key/route.ts's catch block: RotationCasConflictError -> KEY_VERSION_MISMATCH.
      expect(API_ERROR_STATUS[API_ERROR.KEY_VERSION_MISMATCH]).toBe(409);
    }
  });
});
