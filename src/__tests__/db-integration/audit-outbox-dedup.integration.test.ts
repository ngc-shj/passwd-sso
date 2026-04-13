/**
 * ON CONFLICT (outbox_id) DO NOTHING dedup: re-delivering the same
 * outbox row to audit_logs must be idempotent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

describe("audit-outbox dedup (ON CONFLICT)", () => {
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

  const deliverSql = `
    INSERT INTO audit_logs (
      id, tenant_id, scope, action, user_id, actor_type, created_at, outbox_id
    ) VALUES (
      gen_random_uuid(),
      $1::uuid,
      'PERSONAL'::"AuditScope",
      'ENTRY_CREATE'::"AuditAction",
      $2::uuid,
      'HUMAN'::"ActorType",
      $3::timestamptz,
      $4::uuid
    )
    ON CONFLICT (outbox_id) DO NOTHING
  `;

  it("first delivery inserts a row into audit_logs", async () => {
    const outboxId = randomUUID();
    const now = new Date().toISOString();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(deliverSql, tenantId, userId, now, outboxId);
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_logs WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it("re-delivery with same outbox_id does not create a duplicate", async () => {
    const outboxId = randomUUID();
    const now = new Date().toISOString();

    // First delivery
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(deliverSql, tenantId, userId, now, outboxId);
    });

    // Second delivery with same outbox_id — should be a no-op
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(deliverSql, tenantId, userId, now, outboxId);
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_logs WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
    // Still exactly 1
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it("different outbox_id inserts normally", async () => {
    const outboxId1 = randomUUID();
    const outboxId2 = randomUUID();
    const now = new Date().toISOString();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(deliverSql, tenantId, userId, now, outboxId1);
      await tx.$executeRawUnsafe(deliverSql, tenantId, userId, now, outboxId2);
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_logs
         WHERE outbox_id IN ($1::uuid, $2::uuid)`,
        outboxId1,
        outboxId2,
      );
    });
    expect(Number(rows[0].cnt)).toBe(2);
  });
});
