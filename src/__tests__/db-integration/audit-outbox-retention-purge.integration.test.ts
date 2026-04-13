import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";

describe("audit-outbox retention purge", () => {
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

  it("purges old SENT and FAILED rows but preserves active and recent rows", async () => {
    const retentionHours = AUDIT_OUTBOX.RETENTION_HOURS;
    const failedRetentionDays = AUDIT_OUTBOX.FAILED_RETENTION_DAYS;

    const oldSentId = randomUUID();
    const oldFailedId = randomUUID();
    const recentFailedId = randomUUID();
    const pendingId = randomUUID();
    const processingId = randomUUID();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      // Old SENT row — should be purged
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, sent_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', 1, 8, now() - interval '48 hours', now(), now() - make_interval(hours => $4) - interval '1 hour')`,
        oldSentId,
        tenantId,
        makePayload(),
        retentionHours,
      );

      // Old FAILED row — should be purged
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8,
                 now() - make_interval(days => $4) - interval '1 day', now())`,
        oldFailedId,
        tenantId,
        makePayload(),
        failedRetentionDays,
      );

      // Recent FAILED row — should NOT be purged
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now() - interval '1 day', now())`,
        recentFailedId,
        tenantId,
        makePayload(),
      );

      // PENDING row — should NOT be purged regardless of age
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', 0, 8, now() - interval '365 days', now())`,
        pendingId,
        tenantId,
        makePayload(),
      );

      // PROCESSING row — should NOT be purged regardless of age
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, processing_started_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 1, 8, now() - interval '365 days', now(), now())`,
        processingId,
        tenantId,
        makePayload(),
      );
    });

    // Run the purge query (same pattern as purgeRetention in the worker)
    const result = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{ purged: bigint }[]>(
        `WITH deleted AS (
          DELETE FROM audit_outbox
          WHERE (
            status = 'SENT'
            AND sent_at < now() - make_interval(hours => $1)
            AND NOT EXISTS (
              SELECT 1 FROM "audit_deliveries"
              WHERE "audit_deliveries"."outbox_id" = "audit_outbox"."id"
                AND "audit_deliveries"."status" IN ('PENDING', 'PROCESSING')
            )
          )
             OR (status = 'FAILED' AND created_at < now() - make_interval(days => $2))
          RETURNING id
        )
        SELECT COUNT(*) AS purged FROM deleted`,
        retentionHours,
        failedRetentionDays,
      );
      return Number(rows[0]?.purged ?? 0);
    });

    expect(result).toBe(2); // oldSentId + oldFailedId

    // Verify remaining rows
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string; status: string }[]>(
        `SELECT id, status::text FROM audit_outbox WHERE tenant_id = $1::uuid ORDER BY created_at`,
        tenantId,
      );
    });

    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).toContain(recentFailedId);
    expect(remainingIds).toContain(pendingId);
    expect(remainingIds).toContain(processingId);
    expect(remainingIds).not.toContain(oldSentId);
    expect(remainingIds).not.toContain(oldFailedId);
  });
});
