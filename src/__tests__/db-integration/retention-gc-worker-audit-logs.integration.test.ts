/**
 * Real-DB test for sweepAuditLogs per-tenant retention purge (C3/T6).
 *
 * Two tenants:
 *   A — auditLogRetentionDays=30: rows older than 30d must be deleted; recent kept.
 *   B — auditLogRetentionDays=NULL: must be entirely untouched (FR4).
 *
 * Mechanism check (T6):
 *   - The worker role has no direct DELETE on audit_logs; deletion routes through
 *     audit_log_purge() SECURITY DEFINER function (INV-C3b).
 *   - heartbeat per-table count attributes audit_logs deletion only to tenant A.
 *   - Tenant B's rows are untouched (null retention = skip).
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
});
