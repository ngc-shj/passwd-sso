/**
 * Real-DB tests for PER_TENANT_AGE history auto-trim (SC3).
 *
 * Trims password_entry_histories rows whose changed_at is past the tenant's
 * historyRetentionDays. NULL retention = skip. Mirrors the audit_logs per-tenant
 * pattern but with a plain DELETE (history is mutable, no definer fn).
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

const historyEntry = RETENTION_REGISTRY.find(
  (e) =>
    e.kind === "PER_TENANT_AGE" && e.table === "password_entry_histories",
)! as Extract<
  (typeof RETENTION_REGISTRY)[number],
  { kind: "PER_TENANT_AGE" }
>;

describe("retention-gc history auto-trim (SC3)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let entryId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    entryId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_entries (id, user_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag, key_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '\\x00', 'iv', 'tag', '\\x00', 'oiv', 'otag', 1, now(), now())`,
        entryId,
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
        `UPDATE tenants SET history_retention_days = ${days === null ? "NULL" : "$2"} WHERE id = $1::uuid`,
        ...(days === null ? [tenantId] : [tenantId, days]),
      );
    });
  }

  async function insertHistory(ageExpr: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_entry_histories (id, entry_id, tenant_id, encrypted_blob, blob_iv, blob_auth_tag, key_version, changed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '\\x00', 'iv', 'tag', 1, ${ageExpr})`,
        id,
        entryId,
        tenantId,
      );
    });
    return id;
  }

  async function historyExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM password_entry_histories WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  it("trims history older than the tenant's retention, keeps recent history", async () => {
    await setRetention(90);
    const old = await insertHistory("now() - interval '91 days'");
    const recent = await insertHistory("now() - interval '5 days'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepPerTenantAge(tx, historyEntry, 100);
    });

    expect(await historyExists(old)).toBe(false);
    expect(await historyExists(recent)).toBe(true);
  });

  it("does NOT trim any history when the tenant's retention is NULL", async () => {
    await setRetention(null);
    const old = await insertHistory("now() - interval '400 days'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepPerTenantAge(tx, historyEntry, 100);
    });

    expect(await historyExists(old)).toBe(true);
  });

  it("worker role CAN trim history but CANNOT delete audit_logs (least privilege)", async () => {
    await setRetention(30);
    const old = await insertHistory("now() - interval '31 days'");

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await sweepPerTenantAge(tx, historyEntry, 100);
    });
    expect(await historyExists(old)).toBe(false);

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
