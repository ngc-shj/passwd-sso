import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";

describe("audit-outbox purge-failed endpoint (real DB)", () => {
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
    await ctx.deleteTestData(tenantId);
  });

  const makePayload = () =>
    JSON.stringify({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: randomUUID(),
      actorType: ACTOR_TYPE.HUMAN,
    });

  it("purges only FAILED rows; PENDING, PROCESSING, SENT remain", async () => {
    const failedId1 = randomUUID();
    const failedId2 = randomUUID();
    const pendingId = randomUUID();
    const processingId = randomUUID();
    const sentId = randomUUID();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      // FAILED rows
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now(), now())`,
        failedId1, tenantId, makePayload(),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now(), now())`,
        failedId2, tenantId, makePayload(),
      );

      // PENDING row
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', 0, 8, now(), now())`,
        pendingId, tenantId, makePayload(),
      );

      // PROCESSING row
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, processing_started_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 1, 8, now(), now(), now())`,
        processingId, tenantId, makePayload(),
      );

      // SENT row
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, sent_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', 1, 8, now(), now(), now())`,
        sentId, tenantId, makePayload(),
      );
    });

    // Execute the purge-failed query (same pattern as the endpoint)
    const deleted = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{ purged: bigint }[]>(
        `WITH deleted AS (
          DELETE FROM audit_outbox
          WHERE status = 'FAILED'
            AND tenant_id = $1::uuid
          RETURNING id
        )
        SELECT COUNT(*) AS purged FROM deleted`,
        tenantId,
      );
      return Number(rows[0]?.purged ?? 0);
    });

    expect(deleted).toBe(2);

    // Verify remaining rows
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string; status: string }[]>(
        `SELECT id, status::text FROM audit_outbox WHERE tenant_id = $1::uuid ORDER BY created_at`,
        tenantId,
      );
    });

    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).toContain(pendingId);
    expect(remainingIds).toContain(processingId);
    expect(remainingIds).toContain(sentId);
    expect(remainingIds).not.toContain(failedId1);
    expect(remainingIds).not.toContain(failedId2);
  });

  it("respects tenantId filter — does not purge another tenant's FAILED rows", async () => {
    const otherTenantId = await ctx.createTenant();
    const failedInTarget = randomUUID();
    const failedInOther = randomUUID();

    try {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);

        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now(), now())`,
          failedInTarget, tenantId, makePayload(),
        );

        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now(), now())`,
          failedInOther, otherTenantId, makePayload(),
        );
      });

      // Purge only for tenantId
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_outbox WHERE status = 'FAILED' AND tenant_id = $1::uuid`,
          tenantId,
        );
      });

      // Other tenant's row should remain
      const otherRemaining = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM audit_outbox WHERE id = $1::uuid`,
          failedInOther,
        );
      });
      expect(otherRemaining).toHaveLength(1);

      // Target tenant's row should be gone
      const targetRemaining = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM audit_outbox WHERE id = $1::uuid`,
          failedInTarget,
        );
      });
      expect(targetRemaining).toHaveLength(0);
    } finally {
      await ctx.deleteTestData(otherTenantId);
    }
  });

  it("respects olderThanDays filter", async () => {
    const oldFailedId = randomUUID();
    const recentFailedId = randomUUID();
    const olderThanDays = 7;

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      // Old FAILED row (older than 7 days)
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now() - interval '10 days', now())`,
        oldFailedId, tenantId, makePayload(),
      );

      // Recent FAILED row (newer than 7 days)
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now() - interval '2 days', now())`,
        recentFailedId, tenantId, makePayload(),
      );
    });

    // Purge only FAILED rows older than olderThanDays
    const deleted = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{ purged: bigint }[]>(
        `WITH deleted AS (
          DELETE FROM audit_outbox
          WHERE status = 'FAILED'
            AND tenant_id = $1::uuid
            AND created_at < now() - make_interval(days => $2)
          RETURNING id
        )
        SELECT COUNT(*) AS purged FROM deleted`,
        tenantId,
        olderThanDays,
      );
      return Number(rows[0]?.purged ?? 0);
    });

    expect(deleted).toBe(1);

    // Recent FAILED row should remain
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });

    expect(remaining.map((r) => r.id)).toContain(recentFailedId);
    expect(remaining.map((r) => r.id)).not.toContain(oldFailedId);
  });
});
