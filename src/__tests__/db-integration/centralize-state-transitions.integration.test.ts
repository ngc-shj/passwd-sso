/**
 * Integration tests (real DB): centralize-state-transitions refactor.
 *
 * Validates the contract properties that mock-based unit tests cannot exercise:
 *   T6  — concurrency CAS: race two transition() calls; exactly one wins
 *   T9  — wrong from-state: transition() returns { ok: false }, row unchanged
 *   T9b — wrong scope: wrong ownerId WHERE clause → { ok: false }, row unchanged
 *   C3  — bypass-RLS scope guard: throws when called under withBypassRls without resource scope
 *   T16 — vault-reset atomicity (S4): __testHook throw rolls back bulkTransition
 *   T17 — vault auto-promote race (F5/S3): exactly one winner, one EMERGENCY_ACCESS_ACTIVATE audit row
 *   T18 — bulkTransition mixed-status coverage: eligible rows updated, REVOKED untouched, F15 invariant
 *   F14 — bulkTransition keyVersion: null guard: null-keyVersion rows ARE included
 *
 * Run: docker compose up -d db && npm run test:integration -- centralize-state-transitions
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
import { PrismaClient } from "@prisma/client";
import {
  createTestContext,
  setBypassRlsGucs,
  createPrismaForRole,
  raceTwoClients,
  type TestContext,
} from "./helpers";
import { transition, bulkTransition } from "@/lib/emergency-access/emergency-access-state";
import { markGrantsStaleForOwner } from "@/lib/emergency-access/emergency-access-server";
import { autoPromoteIfElapsed } from "@/lib/emergency-access/vault-auto-promote";
import { executeVaultReset } from "@/lib/vault/vault-reset";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { AUDIT_ACTION, EA_STATUS, EA_ACTOR } from "@/lib/constants";
import { AUDIT_SCOPE } from "@/lib/constants/audit/audit";

// ─── Skip guard ──────────────────────────────────────────────────────────────
// Gracefully skip the entire suite if DATABASE_URL is not configured.
const SKIP = !process.env.DATABASE_URL;

// ─── Shared wrapping-key placeholder ─────────────────────────────────────────
const WRAPPING = {
  encryptedSecretKey: "esk-placeholder-centralize",
  secretKeyIv: "a".repeat(24),
  secretKeyAuthTag: "b".repeat(32),
  hkdfSalt: "c".repeat(64),
  ownerEphemeralPublicKey: "ephemeral-pubkey-placeholder",
  granteePublicKey: "grantee-pubkey-placeholder",
};

// ─── Test context ─────────────────────────────────────────────────────────────

describe("centralize-state-transitions — integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let ownerId: string;
  let granteeId: string;
  let secondOwnerId: string;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  beforeEach(async () => {
    if (SKIP) return;
    tenantId = await ctx.createTenant();
    ownerId = await ctx.createUser(tenantId);
    granteeId = await ctx.createUser(tenantId);
    secondOwnerId = await ctx.createUser(tenantId);
  });

  afterEach(async () => {
    if (SKIP) return;
    await ctx.deleteTestData(tenantId);
  });

  // ─── Seed helpers ───────────────────────────────────────────────────────────

  async function seedGrant(opts: {
    id: string;
    status: string;
    keyVersion?: number | null;
    waitExpiresAt?: Date | null;
    ownerEphemeralPublicKey?: string | null;
  }): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO emergency_access_grants (
           id, tenant_id, owner_id, grantee_id, grantee_email,
           status, wait_days, token_hash, token_expires_at,
           encrypted_secret_key, secret_key_iv, secret_key_auth_tag,
           hkdf_salt, owner_ephemeral_public_key, grantee_public_key,
           wrap_version, key_version, wait_expires_at, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
           $6::"EmergencyAccessStatus", 7, $7, now() + interval '30 days',
           $8, $9, $10, $11, $12, $13,
           1, $14, $15, now(), now()
         )`,
        opts.id,
        tenantId,
        ownerId,
        granteeId,
        `grantee-${opts.id.slice(0, 6)}@example.com`,
        opts.status,
        randomBytes(32).toString("hex"),
        WRAPPING.encryptedSecretKey,
        WRAPPING.secretKeyIv,
        WRAPPING.secretKeyAuthTag,
        WRAPPING.hkdfSalt,
        opts.ownerEphemeralPublicKey ?? WRAPPING.ownerEphemeralPublicKey,
        WRAPPING.granteePublicKey,
        opts.keyVersion ?? null,
        opts.waitExpiresAt ?? null,
      );
    });
  }

  async function seedGranteeKeyPair(grantId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO emergency_access_key_pairs (
           id, grant_id, tenant_id,
           encrypted_private_key, private_key_iv, private_key_auth_tag,
           created_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           $4, $5, $6, now()
         )`,
        randomUUID(),
        grantId,
        tenantId,
        "enc-private-key-placeholder",
        "d".repeat(24),
        "e".repeat(32),
      );
    });
  }

  async function fetchStatus(id: string): Promise<string | null> {
    const r = await ctx.su.pool.query(
      `SELECT status FROM emergency_access_grants WHERE id = $1::uuid`,
      [id],
    );
    if (r.rowCount === 0) return null;
    return r.rows[0].status as string;
  }

  async function fetchGrant(id: string): Promise<{
    status: string;
    owner_ephemeral_public_key: string | null;
    revoked_at: Date | null;
  } | null> {
    const r = await ctx.su.pool.query(
      `SELECT status, owner_ephemeral_public_key, revoked_at
       FROM emergency_access_grants WHERE id = $1::uuid`,
      [id],
    );
    if (r.rowCount === 0) return null;
    return r.rows[0] as { status: string; owner_ephemeral_public_key: string | null; revoked_at: Date | null };
  }

  async function countAuditRows(action: string): Promise<number> {
    const r = await ctx.su.pool.query(
      `SELECT count(*) FROM audit_logs WHERE tenant_id = $1::uuid AND action = $2`,
      [tenantId, action],
    );
    return parseInt(r.rows[0].count, 10);
  }

  // ─── T6: Concurrency CAS ────────────────────────────────────────────────────

  it.skipIf(SKIP)("T6: race two transition() calls past PENDING → exactly one ok per iteration (100×)", async () => {
    const clientA = createPrismaForRole("superuser");
    const clientB = createPrismaForRole("superuser");

    try {
      for (let i = 0; i < 100; i++) {
        const grantId = randomUUID();
        await seedGrant({ id: grantId, status: "PENDING" });

        const [a, b] = await raceTwoClients(
          clientA.prisma,
          clientB.prisma,
          async (db: PrismaClient) => {
            await db.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
            await db.$executeRaw`SELECT set_config('app.bypass_purpose', 'cross_tenant_lookup', true)`;
            await db.$executeRaw`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`;
            return transition({
              db,
              // Use granteeId scope for precise CAS — GUC-based bypass, not withBypassRls,
              // so isBypassRlsActive() is false and C3 check does not apply.
              where: { id: grantId, granteeId },
              to: EA_STATUS.ACCEPTED,
              actor: EA_ACTOR.GRANTEE,
            });
          },
          async (db: PrismaClient) => {
            await db.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
            await db.$executeRaw`SELECT set_config('app.bypass_purpose', 'cross_tenant_lookup', true)`;
            await db.$executeRaw`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`;
            return transition({
              db,
              where: { id: grantId, granteeId },
              to: EA_STATUS.ACCEPTED,
              actor: EA_ACTOR.GRANTEE,
            });
          },
        );

        const results = [a.ok, b.ok].sort();
        expect(results).toEqual([false, true]);

        // Clean up this iteration's row so the tenant cleanup in afterEach works
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRawUnsafe(
            `DELETE FROM emergency_access_grants WHERE id = $1::uuid`,
            grantId,
          );
        });
      }
    } finally {
      await Promise.all([
        clientA.prisma.$disconnect().then(() => clientA.pool.end()),
        clientB.prisma.$disconnect().then(() => clientB.pool.end()),
      ]);
    }
  }, 60_000);

  // ─── T9: Wrong from-state ────────────────────────────────────────────────────

  it.skipIf(SKIP)("T9: transition() returns {ok:false} and leaves row unchanged when from-state is wrong", async () => {
    const grantId = randomUUID();
    await seedGrant({ id: grantId, status: "IDLE" });

    // IDLE → ACTIVATED is not in the matrix (only OWNER can do IDLE → REQUESTED)
    const result = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return transition({
        db: tx,
        where: { id: grantId, ownerId },
        to: EA_STATUS.ACTIVATED,
        actor: EA_ACTOR.OWNER,
      });
    });

    expect(result.ok).toBe(false);
    expect(await fetchStatus(grantId)).toBe("IDLE");
  });

  // ─── T9b: Wrong scope (wrong ownerId) ────────────────────────────────────────

  it.skipIf(SKIP)("T9b: transition() returns {ok:false} when WHERE scope doesn't match the row", async () => {
    const grantId = randomUUID();
    await seedGrant({ id: grantId, status: "IDLE" });

    // Correct transition (IDLE → REVOKED, OWNER), but wrong ownerId
    const result = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return transition({
        db: tx,
        where: { id: grantId, ownerId: secondOwnerId },
        to: EA_STATUS.REVOKED,
        actor: EA_ACTOR.OWNER,
      });
    });

    expect(result.ok).toBe(false);
    expect(await fetchStatus(grantId)).toBe("IDLE");
  });

  // ─── C3: Bypass-RLS scope guard ──────────────────────────────────────────────

  it.skipIf(SKIP)("C3: transition() throws under withBypassRls when where lacks resource scope", async () => {
    const grantId = randomUUID();
    await seedGrant({ id: grantId, status: "IDLE" });

    // Calling transition with only { id } under withBypassRls — no ownerId/granteeId/etc.
    await expect(
      withBypassRls(
        ctx.su.prisma,
        async () =>
          transition({
            db: ctx.su.prisma,
            where: { id: grantId },
            to: EA_STATUS.REVOKED,
            actor: EA_ACTOR.OWNER,
          }),
        BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
      ),
    ).rejects.toThrow("transition: under withBypassRls, where must include one of");
  });

  // ─── T16: Vault-reset atomicity (S4) ─────────────────────────────────────────

  it.skipIf(SKIP)("T16: executeVaultReset rolls back bulkTransition when __testHook throws", async () => {
    // Seed a vault-like structure for the owner: at least one grant as owner
    const grantId = randomUUID();
    await seedGrant({ id: grantId, status: "IDLE" });

    // Also seed a minimal vaultKey row so the user can have a vault to reset
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // Ensure the user has a vault setup
      await tx.$executeRawUnsafe(
        `UPDATE users SET vault_setup_at = now(), key_version = 1,
         account_salt = $2, passphrase_verifier_hmac = $3
         WHERE id = $1::uuid`,
        ownerId,
        "salt-placeholder-" + randomBytes(8).toString("hex"),
        "verifier-placeholder-" + randomBytes(8).toString("hex"),
      );
    });

    // Execute vault reset with a __testHook that throws after bulkTransition
    await expect(
      executeVaultReset(ownerId, async () => {
        throw new Error("T16 test hook: intentional rollback");
      }),
    ).rejects.toThrow("T16 test hook: intentional rollback");

    // Assert the grant was NOT marked REVOKED (transaction rolled back)
    expect(await fetchStatus(grantId)).toBe("IDLE");
  });

  // ─── T17: Vault auto-promote race (F5/S3) ─────────────────────────────────────

  it.skipIf(SKIP)("T17: autoPromoteIfElapsed race → exactly one winner, exactly one EMERGENCY_ACCESS_ACTIVATE audit row", async () => {
    const grantId = randomUUID();
    // waitExpiresAt in the past so the grant is eligible for promotion
    const pastDate = new Date(Date.now() - 60_000);
    await seedGrant({
      id: grantId,
      status: "REQUESTED",
      keyVersion: 1,
      waitExpiresAt: pastDate,
    });
    // Seed granteeKeyPair so autoPromoteIfElapsed can return ok (no_escrow check)
    await seedGranteeKeyPair(grantId);

    const auditBase = {
      scope: AUDIT_SCOPE.PERSONAL,
      userId: granteeId,
      ip: "127.0.0.1",
      userAgent: "test",
    };
    const now = new Date();

    // T17 uses Promise.all + per-call withBypassRls because autoPromoteIfElapsed
    // does NOT call withBypassRls itself (caller-owned scope; see route handler
    // and the lib's file header). Each call opens its own withBypassRls scope,
    // gets a separate AsyncLocalStorage context + DB transaction, distinct
    // pool connection. PostgreSQL row-level locking on emergencyAccessGrant
    // guarantees the CAS predicate sees exactly one REQUESTED-eligible row,
    // exactly one transition succeeds.
    const [a, b] = await Promise.all([
      withBypassRls(
        ctx.app.prisma,
        async () => autoPromoteIfElapsed({ granteeId, grantId, now, auditBase }),
        BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
      ),
      withBypassRls(
        ctx.app.prisma,
        async () => autoPromoteIfElapsed({ granteeId, grantId, now, auditBase }),
        BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
      ),
    ]);

    const successCount = [a, b].filter((r) => r.ok).length;
    expect(successCount).toBe(1);

    // Exactly one EMERGENCY_ACCESS_ACTIVATE audit row should exist.
    // logAuditAsync is async / outbox-based, so we poll audit_logs until the
    // worker drains the outbox row (CI runners are slower than local dev —
    // a fixed-duration sleep is flaky; poll-with-timeout is deterministic).
    let activateCount = 0;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      activateCount = await countAuditRows(AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE);
      if (activateCount >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(activateCount).toBe(1);

    // The grant must now be ACTIVATED
    expect(await fetchStatus(grantId)).toBe("ACTIVATED");
  }, 15_000);

  // ─── T18: bulkTransition mixed-status coverage ────────────────────────────────

  it.skipIf(SKIP)("T18: bulkTransition marks eligible rows STALE, leaves REVOKED untouched, nulls ownerEphemeralPublicKey (F15)", async () => {
    const idleId = randomUUID();
    const requestedId = randomUUID();
    const activatedId = randomUUID();
    const revokedId = randomUUID();

    await Promise.all([
      seedGrant({ id: idleId, status: "IDLE", keyVersion: 1 }),
      seedGrant({ id: requestedId, status: "REQUESTED", keyVersion: 1 }),
      seedGrant({ id: activatedId, status: "ACTIVATED", keyVersion: 1 }),
      seedGrant({ id: revokedId, status: "REVOKED", keyVersion: 1 }),
    ]);

    const result = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return bulkTransition({
        db: tx,
        where: {
          ownerId,
          OR: [{ keyVersion: { lt: 2 } }, { keyVersion: null }],
        },
        to: EA_STATUS.STALE,
        actor: EA_ACTOR.SYSTEM,
        extraData: { ownerEphemeralPublicKey: null },
      });
    });

    // (a) Correct updated count (IDLE + REQUESTED + ACTIVATED = 3; REVOKED excluded)
    expect(result.updated).toBe(3);

    // (b) Eligible rows flipped to STALE
    expect(await fetchStatus(idleId)).toBe("STALE");
    expect(await fetchStatus(requestedId)).toBe("STALE");
    expect(await fetchStatus(activatedId)).toBe("STALE");

    // (c) REVOKED row untouched
    expect(await fetchStatus(revokedId)).toBe("REVOKED");

    // (d) F15 invariant: ownerEphemeralPublicKey nulled on all updated rows
    for (const id of [idleId, requestedId, activatedId]) {
      const g = await fetchGrant(id);
      expect(g?.owner_ephemeral_public_key).toBeNull();
    }

    // REVOKED row retains its ephemeral key (was not touched)
    const revokedGrant = await fetchGrant(revokedId);
    expect(revokedGrant?.owner_ephemeral_public_key).toBe(WRAPPING.ownerEphemeralPublicKey);
  });

  // ─── F14: keyVersion: null guard ─────────────────────────────────────────────

  it.skipIf(SKIP)("F14: markGrantsStaleForOwner includes null-keyVersion grants AND excludes high-keyVersion grants (OR clause both arms)", async () => {
    const nullVersionId = randomUUID();
    const oldVersionId = randomUUID();
    const futureVersionId = randomUUID();
    await Promise.all([
      seedGrant({ id: nullVersionId, status: "IDLE", keyVersion: null }),
      seedGrant({ id: oldVersionId, status: "IDLE", keyVersion: 1 }),
      // keyVersion >= newKeyVersion (= 2) must NOT be marked STALE — proves
      // the `lt` predicate arm is preserved, not silently widened to "all".
      seedGrant({ id: futureVersionId, status: "IDLE", keyVersion: 99 }),
    ]);

    const cleared = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return markGrantsStaleForOwner(ownerId, 2, tx);
    });

    // null-keyVersion AND old (keyVersion < 2) rows ARE included (F14 inclusion arm)
    expect(cleared).toBeGreaterThanOrEqual(2);
    expect(await fetchStatus(nullVersionId)).toBe("STALE");
    expect(await fetchStatus(oldVersionId)).toBe("STALE");
    // High-keyVersion row remains IDLE — F14 exclusion arm (predicate is `lt`, not unconditional)
    expect(await fetchStatus(futureVersionId)).toBe("IDLE");
  });
});
