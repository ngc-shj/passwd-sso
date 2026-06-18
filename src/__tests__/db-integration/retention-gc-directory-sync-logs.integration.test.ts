/**
 * Real-DB test for SC7 directory-sync-log retention (PER_TENANT_AGE).
 *
 * Companion to retention-gc-append-only-logs (share_access_logs). This exercises
 * the directory_sync_logs table specifically: started_at age basis (no created_at
 * column), child of directory_sync_configs. Verifies the live worker DELETE path,
 * NULL = never, and worker least-privilege.
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

const syncLogEntry = RETENTION_REGISTRY.find(
  (e) => e.kind === "PER_TENANT_AGE" && e.table === "directory_sync_logs",
)! as Extract<(typeof RETENTION_REGISTRY)[number], { kind: "PER_TENANT_AGE" }>;

describe("retention-gc directory-sync-log retention (SC7)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let configId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    configId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO directory_sync_configs
           (id, tenant_id, provider, display_name, enabled, sync_interval_minutes,
            encrypted_credentials, credentials_iv, credentials_auth_tag, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'OKTA'::"DirectorySyncProvider", 'test-config', true, 60,
            '\\x00', 'iv', 'tag', 'IDLE'::"DirectorySyncStatus", now(), now())`,
        configId,
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
        `UPDATE tenants SET directory_sync_log_retention_days = ${days === null ? "NULL" : "$2"} WHERE id = $1::uuid`,
        ...(days === null ? [tenantId] : [tenantId, days]),
      );
    });
  }

  async function insertSyncLog(ageExpr: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO directory_sync_logs
           (id, config_id, tenant_id, status, started_at, dry_run,
            users_created, users_updated, users_deactivated, groups_updated)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUCCESS'::"DirectorySyncStatus", ${ageExpr}, false, 0, 0, 0, 0)`,
        id,
        configId,
        tenantId,
      );
    });
    return id;
  }

  async function logExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM directory_sync_logs WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  it("deletes sync logs older than the tenant retention, keeps recent", async () => {
    await setRetention(30);
    const old = await insertSyncLog("now() - interval '31 days'");
    const recent = await insertSyncLog("now() - interval '5 days'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepPerTenantAge(tx, syncLogEntry, 100);
    });

    expect(await logExists(old)).toBe(false);
    expect(await logExists(recent)).toBe(true);
  });

  it("does NOT delete when the tenant retention is NULL", async () => {
    await setRetention(null);
    const old = await insertSyncLog("now() - interval '400 days'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepPerTenantAge(tx, syncLogEntry, 100);
    });

    expect(await logExists(old)).toBe(true);
  });

  it("worker role CAN delete logs but CANNOT delete audit_logs (least privilege)", async () => {
    await setRetention(30);
    const old = await insertSyncLog("now() - interval '31 days'");

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await sweepPerTenantAge(tx, syncLogEntry, 100);
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
