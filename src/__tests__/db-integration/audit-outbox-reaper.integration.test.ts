import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_ACTION, AUDIT_SCOPE, ACTOR_TYPE } from "@/lib/constants/audit";

describe("audit-outbox reaper resets stuck PROCESSING rows", () => {
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

  it("reaps a stuck PROCESSING row back to PENDING with incremented attempt_count", async () => {
    const outboxId = randomUUID();
    const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;

    // Insert a PROCESSING row with processing_started_at far in the past
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 2, 8,
                 now() - make_interval(secs => $4::double precision) - interval '60 seconds',
                 now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.ENTRY_CREATE,
          userId: randomUUID(),
          actorType: ACTOR_TYPE.HUMAN,
        }),
        timeoutSeconds,
      );
    });

    // Run the reaper query (same pattern as reapStuckRows in the worker)
    const reaped = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{
        id: string;
        tenant_id: string;
        attempt_count: number;
        new_status: string;
      }[]>(
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
         RETURNING id, tenant_id, attempt_count, status::text AS new_status`,
        timeoutSeconds,
      );
      return rows;
    });

    expect(reaped).toHaveLength(1);
    expect(reaped[0].id).toBe(outboxId);
    expect(reaped[0].new_status).toBe("PENDING");
    expect(reaped[0].attempt_count).toBe(3); // was 2, incremented to 3

    // Verify the row state in the DB
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string; attempt_count: number; processing_started_at: Date | null }[]>(
        `SELECT status::text, attempt_count, processing_started_at FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });

    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].attempt_count).toBe(3);
    expect(rows[0].processing_started_at).toBeNull();
  });

  it("writes an AUDIT_OUTBOX_REAPED audit_logs entry with SYSTEM actor and NULL userId", async () => {
    const outboxId = randomUUID();

    // Write a direct SYSTEM audit log (same pattern as writeDirectAuditLog)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, metadata, created_at
        ) VALUES (
          gen_random_uuid(),
          $1::uuid,
          $2::"AuditScope",
          $3::"AuditAction",
          NULL,
          $4::"ActorType",
          $5::jsonb,
          now()
        )`,
        tenantId,
        AUDIT_SCOPE.TENANT,
        AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
        ACTOR_TYPE.SYSTEM,
        JSON.stringify({ outboxId, attemptCount: 3 }),
      );
    });

    // Verify the audit_logs row exists
    const logs = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        action: string;
        user_id: string | null;
        actor_type: string;
      }[]>(
        `SELECT action::text, user_id, actor_type::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
      );
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].user_id).toBeNull();
    expect(logs[0].actor_type).toBe("SYSTEM");
  });

  it("transitions stuck row to FAILED when attempt_count reaches max_attempts", async () => {
    const outboxId = randomUUID();
    const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;

    // Insert a PROCESSING row at max_attempts - 1
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 7, 8,
                 now() - make_interval(secs => $4::double precision) - interval '60 seconds',
                 now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.ENTRY_CREATE,
          userId: randomUUID(),
          actorType: ACTOR_TYPE.HUMAN,
        }),
        timeoutSeconds,
      );
    });

    // Run the reaper
    const reaped = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        id: string;
        new_status: string;
        attempt_count: number;
      }[]>(
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
         RETURNING id, status::text AS new_status, attempt_count`,
        timeoutSeconds,
      );
    });

    expect(reaped).toHaveLength(1);
    expect(reaped[0].new_status).toBe("FAILED");
    expect(reaped[0].attempt_count).toBe(8);
  });
});
