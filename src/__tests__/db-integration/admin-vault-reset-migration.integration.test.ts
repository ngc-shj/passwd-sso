/**
 * Integration test (real DB): admin_vault_reset_dual_approval data backfill.
 *
 * Plan: docs/archive/review/admin-vault-reset-dual-approval-plan.md §11.2
 *   - T2 (Critical, F24/S18/T13 fix): regression for NFR3 — auto-revoke
 *     in-flight legacy rows; preserve EXECUTED/REVOKED/EXPIRED rows; emit
 *     SYSTEM-actor audit row per auto-revoked row (S17).
 *
 * Strategy: the migration SQL is idempotent — re-running the UPDATEs
 * against rows in the post-migration shape exercises the same predicates
 * the migration applied. Each test row mimics the legacy shape (no
 * approval columns set) and we re-run the backfill SQL fragments to
 * assert their effect.
 *
 * Run: docker compose up -d db && npm run test:integration -- \
 *      admin-vault-reset-migration.integration
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
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { deriveResetStatus } from "@/lib/vault/admin-reset-status";

interface ResetRow {
  id: string;
  approvedAt: Date | null;
  approvedById: string | null;
  executedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  targetEmailAtInitiate: string | null;
}

describe("admin-vault-reset migration backfill (real DB)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let targetUserId: string;
  let initiatorId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    targetUserId = await ctx.createUser(tenantId);
    initiatorId = await ctx.createUser(tenantId);
  });

  afterEach(async () => {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // The audit_logs row inserted by the backfill must be cleaned up
      // before deleteTestData (which expects no FK survivors).
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM admin_vault_resets WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  /**
   * Insert a row in the legacy pre-migration shape: NULL targetEmailAtInitiate,
   * NULL approvedAt/approvedById, custom executed/revoked/expired state.
   */
  async function insertLegacyRow(opts: {
    executedAt?: Date | null;
    revokedAt?: Date | null;
    expiresAt: Date;
    createdAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const tokenHash = (id + id).replace(/-/g, "").slice(0, 64);
    const createdAt = opts.createdAt ?? new Date(Date.now() - 60_000);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO admin_vault_resets (
           id, tenant_id, target_user_id, initiated_by_id,
           token_hash, target_email_at_initiate,
           expires_at, executed_at, revoked_at, created_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5, NULL,
           $6::timestamptz, $7, $8, $9::timestamptz
         )`,
        id,
        tenantId,
        targetUserId,
        initiatorId,
        tokenHash,
        opts.expiresAt,
        opts.executedAt,
        opts.revokedAt,
        createdAt,
      );
    });
    return id;
  }

  async function readRow(id: string): Promise<ResetRow> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const row = await tx.adminVaultReset.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          approvedAt: true,
          approvedById: true,
          executedAt: true,
          revokedAt: true,
          expiresAt: true,
          createdAt: true,
          targetEmailAtInitiate: true,
        },
      });
      return row;
    });
  }

  /**
   * Re-run the backfill SQL fragments from
   * prisma/migrations/20260430120002_admin_vault_reset_backfill/migration.sql
   * — scoped to this test's tenant so cross-test rows are not touched.
   */
  async function runBackfill(): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      // 1. Auto-revoke in-flight legacy rows.
      await tx.$executeRawUnsafe(
        `UPDATE admin_vault_resets
            SET revoked_at = created_at
          WHERE tenant_id = $1::uuid
            AND executed_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > now()`,
        tenantId,
      );

      // 2. Populate target_email_at_initiate.
      await tx.$executeRawUnsafe(
        `UPDATE admin_vault_resets r
            SET target_email_at_initiate = u.email
           FROM users u
          WHERE r.tenant_id = $1::uuid
            AND r.target_user_id = u.id
            AND r.target_email_at_initiate IS NULL`,
        tenantId,
      );

      // 3. Emit SYSTEM-actor audit row per auto-revoked row.
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
           id, tenant_id, scope, actor_type, user_id, action,
           target_type, target_id, metadata, created_at
         )
         SELECT
           gen_random_uuid(),
           r.tenant_id,
           'TENANT'::"AuditScope",
           'SYSTEM'::"ActorType",
           r.initiated_by_id,
           'ADMIN_VAULT_RESET_REVOKE'::"AuditAction",
           'User',
           r.target_user_id,
           jsonb_build_object(
             'resetId', r.id,
             'reason', 'dual_approval_migration',
             'initiatedById', r.initiated_by_id
           ),
           now()
         FROM admin_vault_resets r
         WHERE r.tenant_id = $1::uuid
           AND r.revoked_at = r.created_at
           AND r.executed_at IS NULL`,
        tenantId,
      );
    });
  }

  // ─── Per-row state assertions ───────────────────────────────

  it("PENDING legacy row → revoked_at = created_at after backfill", async () => {
    const future = new Date(Date.now() + 23 * 60 * 60 * 1000); // expiresAt > now
    const id = await insertLegacyRow({ expiresAt: future });

    await runBackfill();

    const row = await readRow(id);
    expect(row.revokedAt).not.toBeNull();
    // Postgres timestamptz round-trip: compare via getTime() to avoid TZ drift.
    expect(row.revokedAt?.getTime()).toBe(row.createdAt.getTime());
    expect(row.approvedAt).toBeNull();
    expect(row.approvedById).toBeNull();
    expect(row.executedAt).toBeNull();
    expect(row.targetEmailAtInitiate).not.toBeNull();
    expect(deriveResetStatus(row)).toBe("revoked");
  });

  it("EXECUTED row is untouched by backfill (timestamps preserved)", async () => {
    const executedAt = new Date(Date.now() - 30 * 60 * 1000);
    const future = new Date(Date.now() + 23 * 60 * 60 * 1000);
    const id = await insertLegacyRow({
      executedAt,
      expiresAt: future,
    });

    const before = await readRow(id);
    await runBackfill();
    const after = await readRow(id);

    expect(after.executedAt?.getTime()).toBe(before.executedAt?.getTime());
    expect(after.revokedAt).toBeNull();
    expect(after.approvedAt).toBeNull();
    expect(after.approvedById).toBeNull();
    expect(deriveResetStatus(after)).toBe("executed");
  });

  it("REVOKED row is untouched by backfill", async () => {
    const revokedAt = new Date(Date.now() - 30 * 60 * 1000);
    const future = new Date(Date.now() + 23 * 60 * 60 * 1000);
    const id = await insertLegacyRow({ revokedAt, expiresAt: future });

    const before = await readRow(id);
    await runBackfill();
    const after = await readRow(id);

    expect(after.revokedAt?.getTime()).toBe(before.revokedAt?.getTime());
    expect(after.approvedAt).toBeNull();
    expect(after.executedAt).toBeNull();
    expect(deriveResetStatus(after)).toBe("revoked");
  });

  it("EXPIRED row is untouched by backfill (only email populated)", async () => {
    const past = new Date(Date.now() - 60 * 1000); // already expired
    const id = await insertLegacyRow({ expiresAt: past });

    await runBackfill();
    const row = await readRow(id);

    expect(row.revokedAt).toBeNull();
    expect(row.executedAt).toBeNull();
    expect(row.approvedAt).toBeNull();
    expect(row.targetEmailAtInitiate).not.toBeNull();
    expect(deriveResetStatus(row)).toBe("expired");
  });

  // ─── Negative invariant: no synthetic approvals ─────────────

  it("post-backfill: no row has approvedAt set (round-1 sentinel is gone)", async () => {
    // Mix of states.
    await insertLegacyRow({ expiresAt: new Date(Date.now() + 60_000) }); // pending
    await insertLegacyRow({
      executedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await insertLegacyRow({
      revokedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await insertLegacyRow({ expiresAt: new Date(Date.now() - 60_000) }); // expired

    await runBackfill();

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.adminVaultReset.findMany({
        where: { tenantId },
        select: { approvedAt: true, approvedById: true },
      });
    });

    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.approvedAt).toBeNull();
      expect(row.approvedById).toBeNull();
    }
  });

  // ─── SYSTEM-actor audit row coverage (S17) ─────────────────

  it("emits one SYSTEM-actor audit row per auto-revoked legacy row", async () => {
    // Two PENDING rows that should be auto-revoked.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const r1 = await insertLegacyRow({ expiresAt: future });
    const r2 = await insertLegacyRow({ expiresAt: future });

    // Plus one already-EXECUTED row that must NOT trigger an audit row.
    await insertLegacyRow({
      executedAt: new Date(Date.now() - 30 * 60 * 1000),
      expiresAt: future,
    });

    await runBackfill();

    const auditRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        Array<{
          actor_type: string;
          action: string;
          target_id: string;
          metadata: Record<string, unknown>;
        }>
      >(
        `SELECT actor_type::text, action::text, target_id::text, metadata
           FROM audit_logs
          WHERE tenant_id = $1::uuid
            AND actor_type = 'SYSTEM'
            AND action = 'ADMIN_VAULT_RESET_REVOKE'
            AND metadata->>'reason' = 'dual_approval_migration'`,
        tenantId,
      );
    });

    expect(auditRows.length).toBe(2);
    const resetIds = auditRows.map((r) => r.metadata.resetId);
    expect(resetIds).toContain(r1);
    expect(resetIds).toContain(r2);
    for (const r of auditRows) {
      expect(r.target_id).toBe(targetUserId);
      expect(r.metadata.initiatedById).toBe(initiatorId);
    }
  });
});
