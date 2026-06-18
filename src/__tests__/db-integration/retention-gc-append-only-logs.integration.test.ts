/**
 * Real-DB test for SC7 append-only log retention (PER_TENANT_AGE).
 *
 * Representative: share_access_logs (created_at age basis). directory_sync_logs
 * and notifications share the identical PER_TENANT_AGE codepath (covered by the
 * registry DMMF check + the sweep unit test); this exercises the live DB path.
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
import { sweepPerTenantAge } from "@/workers/retention-gc-worker/sweep";
import { RETENTION_REGISTRY } from "@/workers/retention-gc-worker/registry";

const shareLogEntry = RETENTION_REGISTRY.find(
  (e) => e.kind === "PER_TENANT_AGE" && e.table === "share_access_logs",
)! as Extract<(typeof RETENTION_REGISTRY)[number], { kind: "PER_TENANT_AGE" }>;

describe("retention-gc append-only log retention (SC7)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let shareId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    shareId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_shares (id, token_hash, encrypted_data, data_iv, data_auth_tag, expires_at, created_by_id, tenant_id, created_at)
         VALUES ($1::uuid, $2, '\\x00', 'iv', 'tag', now() + interval '7 days', $3::uuid, $4::uuid, now())`,
        shareId,
        `sh-${shareId.slice(0, 16)}`,
        userId,
        tenantId,
      );
    });
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function setRetention(days: number | null): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET share_access_log_retention_days = ${days === null ? "NULL" : "$2"} WHERE id = $1::uuid`,
        ...(days === null ? [tenantId] : [tenantId, days]),
      );
    });
  }

  async function insertAccessLog(ageExpr: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO share_access_logs (id, share_id, tenant_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, ${ageExpr})`,
        id,
        shareId,
        tenantId,
      );
    });
    return id;
  }

  async function logExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM share_access_logs WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  it("deletes access logs older than the tenant retention, keeps recent", async () => {
    await setRetention(30);
    const old = await insertAccessLog("now() - interval '31 days'");
    const recent = await insertAccessLog("now() - interval '5 days'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepPerTenantAge(tx, shareLogEntry, 100);
    });

    expect(await logExists(old)).toBe(false);
    expect(await logExists(recent)).toBe(true);
  });

  it("does NOT delete when the tenant retention is NULL", async () => {
    await setRetention(null);
    const old = await insertAccessLog("now() - interval '400 days'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepPerTenantAge(tx, shareLogEntry, 100);
    });

    expect(await logExists(old)).toBe(true);
  });

  it("worker role CAN delete logs but CANNOT delete audit_logs (least privilege)", async () => {
    await setRetention(30);
    const old = await insertAccessLog("now() - interval '31 days'");

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await sweepPerTenantAge(tx, shareLogEntry, 100);
    });
    expect(await logExists(old)).toBe(false);

    await expect(
      ctx.retentionWorker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
