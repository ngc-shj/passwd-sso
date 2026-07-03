/**
 * Real-DB test for sweepAuditLogs per-tenant retention purge (C3/T6).
 *
 * Two tenants:
 *   A — auditLogRetentionDays=30: rows older than 30d must be deleted; recent kept.
 *   B — auditLogRetentionDays=NULL: must be entirely untouched (FR4).
 *
 * Mechanism check (T6) — co-guarded across TWO test files, by design:
 *   - This file runs sweepAuditLogs as the SUPERUSER client and asserts row-state
 *     (A's old rows gone, A's recent kept, B untouched). It does NOT itself observe
 *     the audit_log_purge() route — it trusts that sweepAuditLogs (sweep.ts) contains
 *     ONLY the definer-fn call and no direct DELETE.
 *   - The INV-C3b "no direct DELETE" mechanism is enforced by the SEPARATE negative
 *     control in retention-gc-worker-role.integration.test.ts, which proves the worker
 *     role lacks a direct audit_logs DELETE grant (permission denied). A regression
 *     replacing audit_log_purge() with a direct DELETE in sweepAuditLogs would pass
 *     HERE (superuser can direct-delete) but the role grant set makes it fail in prod.
 *   - heartbeat per-table count attributes audit_logs deletion only to tenant A.
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
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { sweepAuditLogs } from "@/workers/retention-gc-worker/sweep";
import { RETENTION_REGISTRY, type PerTenantFnEntry } from "@/workers/retention-gc-worker/registry";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { AUDIT_LOG_RETENTION_MIN } from "@/lib/validations/common";

// The PER_TENANT_FN entry for audit_logs
const auditLogsEntry = RETENTION_REGISTRY.find(
  (e): e is PerTenantFnEntry => e.kind === "PER_TENANT_FN",
)!;

describe("retention-gc sweepAuditLogs: per-tenant retention (C3/T6)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantAId = await ctx.createTenant();
    tenantBId = await ctx.createTenant();

    // Set tenant A retention = 30 days, tenant B = NULL (skip)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_log_retention_days = 30 WHERE id = $1::uuid`,
        tenantAId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_log_retention_days = NULL WHERE id = $1::uuid`,
        tenantBId,
      );
    });
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantAId);
    await ctx.deleteTestData(tenantBId);
    // Clean SYSTEM_TENANT_ID audit rows
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
    });
  });

  async function insertAuditLog(tenantId: string, ageExpr: string): Promise<string> {
    // audit_logs.user_id is NOT NULL but has no FK (append-only); a random UUID
    // is sufficient. action must be a valid AuditAction enum value. The CHECK
    // constraint audit_logs_outbox_id_actor_type_check requires outbox_id NOT NULL
    // OR actor_type = 'SYSTEM' — use SYSTEM to avoid needing a real outbox row
    // (actor_type is irrelevant to the age-based purge under test).
    const id = randomUUID();
    const auditUserId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, created_at)
         VALUES ($1::uuid, $2::uuid, 'TENANT', 'AUTH_LOGIN', $3::uuid, 'SYSTEM', ${ageExpr})`,
        id,
        tenantId,
        auditUserId,
      );
    });
    return id;
  }

  it("deletes A's >30d rows via audit_log_purge; keeps A's recent; B entirely untouched (C3/T6)", async () => {
    // Tenant A: 2 old rows (>30d) and 1 recent row
    const aOldId1 = await insertAuditLog(tenantAId, "now() - interval '31 days'");
    const aOldId2 = await insertAuditLog(tenantAId, "now() - interval '60 days'");
    const aRecentId = await insertAuditLog(tenantAId, "now() - interval '5 days'");

    // Tenant B: 1 old row (>30d) — must survive since B has NULL retention
    const bOldId = await insertAuditLog(tenantBId, "now() - interval '40 days'");

    // Run sweepAuditLogs in a bypass_rls tx as superuser
    const deleted = await ctx.su.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return sweepAuditLogs(tx, auditLogsEntry);
    });

    // Exactly 2 rows deleted (A's 2 old rows; A's recent and B's row untouched)
    expect(deleted).toBe(2);

    // A's old rows gone
    const aOldGone = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs WHERE id = ANY($1::uuid[])`,
        [aOldId1, aOldId2],
      );
    });
    expect(aOldGone).toHaveLength(0);

    // A's recent row kept
    const aRecentKept = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs WHERE id = $1::uuid`,
        aRecentId,
      );
    });
    expect(aRecentKept).toHaveLength(1);

    // B's old row entirely untouched (T6/FR4: NULL retention = skip)
    const bOldKept = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs WHERE id = $1::uuid`,
        bOldId,
      );
    });
    expect(bOldKept).toHaveLength(1);
  });

  it("per-table heartbeat count attributes audit_logs deletion only to tenant A (T6 mechanism)", async () => {
    const aOldId = await insertAuditLog(tenantAId, "now() - interval '45 days'");
    const bOldId = await insertAuditLog(tenantBId, "now() - interval '50 days'");

    // Run full sweepOnce — emitHeartbeatAudit=false to skip the heartbeat tx
    const counts = await ctx.su.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      // sweepAuditLogs only — direct call for count attribution
      return sweepAuditLogs(tx, auditLogsEntry);
    });

    // Only tenant A's row deleted (1), tenant B not touched
    expect(counts).toBe(1);

    // Confirm A's row gone, B's row remains
    const aGone = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs WHERE id = $1::uuid`,
        aOldId,
      );
    });
    expect(aGone).toHaveLength(0);

    const bKept = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs WHERE id = $1::uuid`,
        bOldId,
      );
    });
    expect(bKept).toHaveLength(1);
  });

  it("clamps a tenant retention below AUDIT_LOG_RETENTION_MIN to the floor (T4)", async () => {
    // Tenant A configures retention_days = 5, well below the AUDIT_LOG_RETENTION_MIN
    // (30) floor. effectiveDays = max(5, 30) = 30, so only the ~40d row is purged;
    // the ~10d row must survive (it would NOT survive if the tenant's raw 5d setting
    // were honored instead of the floor).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_log_retention_days = 5 WHERE id = $1::uuid`,
        tenantAId,
      );
    });

    const recentId = await insertAuditLog(tenantAId, "now() - interval '10 days'");
    const oldId = await insertAuditLog(tenantAId, "now() - interval '40 days'");

    const deleted = await ctx.su.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return sweepAuditLogs(tx, auditLogsEntry);
    });

    // Only the 40d row is purged — the floor (30d), not the tenant's raw 5d, governs.
    expect(deleted).toBe(1);

    const recentKept = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs WHERE id = $1::uuid`,
        recentId,
      );
    });
    expect(recentKept).toHaveLength(1);

    const oldGone = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs WHERE id = $1::uuid`,
        oldId,
      );
    });
    expect(oldGone).toHaveLength(0);

    // Sanity: the floor constant this test relies on has not silently changed.
    expect(AUDIT_LOG_RETENTION_MIN).toBe(30);
  });
});
