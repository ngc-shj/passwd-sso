/**
 * Real-DB test for SC7 notification retention (PER_TENANT_AGE).
 *
 * Companion to retention-gc-append-only-logs (share_access_logs). This exercises
 * the notifications table specifically: created_at age basis, child of users.
 * Verifies the live worker DELETE path, NULL = never, and worker least-privilege.
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

const notificationEntry = RETENTION_REGISTRY.find(
  (e) => e.kind === "PER_TENANT_AGE" && e.table === "notifications",
)! as Extract<(typeof RETENTION_REGISTRY)[number], { kind: "PER_TENANT_AGE" }>;

describe("retention-gc notification retention (SC7)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function setRetention(days: number | null): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET notification_retention_days = ${days === null ? "NULL" : "$2"} WHERE id = $1::uuid`,
        ...(days === null ? [tenantId] : [tenantId, days]),
      );
    });
  }

  async function insertNotification(ageExpr: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO notifications
           (id, user_id, tenant_id, type, title, body, is_read, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'SECURITY_ALERT'::"NotificationType", 'title', 'body', false, ${ageExpr})`,
        id,
        userId,
        tenantId,
      );
    });
    return id;
  }

  async function notificationExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM notifications WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  it("deletes notifications older than the tenant retention, keeps recent", async () => {
    await setRetention(30);
    const old = await insertNotification("now() - interval '31 days'");
    const recent = await insertNotification("now() - interval '5 days'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepPerTenantAge(tx, notificationEntry, 100);
    });

    expect(await notificationExists(old)).toBe(false);
    expect(await notificationExists(recent)).toBe(true);
  });

  it("does NOT delete when the tenant retention is NULL", async () => {
    await setRetention(null);
    const old = await insertNotification("now() - interval '400 days'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepPerTenantAge(tx, notificationEntry, 100);
    });

    expect(await notificationExists(old)).toBe(true);
  });

  it("worker role CAN delete notifications but CANNOT delete audit_logs (least privilege)", async () => {
    await setRetention(30);
    const old = await insertNotification("now() - interval '31 days'");

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await sweepPerTenantAge(tx, notificationEntry, 100);
    });
    expect(await notificationExists(old)).toBe(false);

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
