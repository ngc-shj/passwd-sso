import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";

describe("audit-outbox reaper non-interference with in-flight rows", () => {
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

  it("only reaps stuck rows; fresh in-flight rows remain PROCESSING", async () => {
    const freshRowId = randomUUID();
    const stuckRowId = randomUUID();
    const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;

    const payload = JSON.stringify({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: randomUUID(),
      actorType: ACTOR_TYPE.HUMAN,
    });

    // Insert two PROCESSING rows
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      // Row A: fresh (processing_started_at = now), should NOT be reaped
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 1, 8, now(), now(), now())`,
        freshRowId,
        tenantId,
        payload,
      );

      // Row B: stuck (processing_started_at far in the past), should be reaped
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 1, 8,
                 now() - make_interval(secs => $4::double precision) - interval '120 seconds',
                 now(), now())`,
        stuckRowId,
        tenantId,
        payload,
        timeoutSeconds,
      );
    });

    // Run the reaper query
    const reaped = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string; new_status: string }[]>(
        `UPDATE audit_outbox
         SET status = CASE
               WHEN attempt_count + 1 >= max_attempts THEN 'FAILED'::"AuditOutboxStatus"
               ELSE 'PENDING'::"AuditOutboxStatus"
             END,
             processing_started_at = NULL,
             attempt_count = attempt_count + 1,
             last_error = LEFT('[reaped after timeout, attempt ' || (attempt_count + 1)::text || ']', 1024)
         WHERE id IN (
           SELECT id FROM audit_outbox
           WHERE status = 'PROCESSING'
             AND processing_started_at < now() - make_interval(secs => $1)
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, status::text AS new_status`,
        timeoutSeconds,
      );
    });

    // Only the stuck row should have been reaped
    expect(reaped).toHaveLength(1);
    expect(reaped[0].id).toBe(stuckRowId);

    // Verify Row A is still PROCESSING
    const freshRow = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string; processing_started_at: Date | null }[]>(
        `SELECT status::text, processing_started_at FROM audit_outbox WHERE id = $1::uuid`,
        freshRowId,
      );
    });

    expect(freshRow[0].status).toBe("PROCESSING");
    expect(freshRow[0].processing_started_at).not.toBeNull();

    // Verify Row B was reaped to PENDING
    const stuckRow = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string; processing_started_at: Date | null }[]>(
        `SELECT status::text, processing_started_at FROM audit_outbox WHERE id = $1::uuid`,
        stuckRowId,
      );
    });

    expect(stuckRow[0].status).toBe("PENDING");
    expect(stuckRow[0].processing_started_at).toBeNull();
  });
});
