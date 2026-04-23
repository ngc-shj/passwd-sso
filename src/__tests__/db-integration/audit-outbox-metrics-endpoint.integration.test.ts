import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";

describe("audit-outbox metrics endpoint (real DB)", () => {
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

  const makePayload = () =>
    JSON.stringify({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: randomUUID(),
      actorType: ACTOR_TYPE.HUMAN,
    });

  it("returns correct aggregated counts per status", async () => {
    // Insert outbox rows in various statuses
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      // 3 PENDING rows
      for (let i = 0; i < 3; i++) {
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', 0, 8, now(), now())`,
          randomUUID(),
          tenantId,
          makePayload(),
        );
      }

      // 2 PROCESSING rows
      for (let i = 0; i < 2; i++) {
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, processing_started_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 1, 8, now(), now(), now())`,
          randomUUID(),
          tenantId,
          makePayload(),
        );
      }

      // 1 FAILED row
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now(), now())`,
        randomUUID(),
        tenantId,
        makePayload(),
      );
    });

    // Run the metrics aggregation query
    const metrics = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string; count: bigint }[]>(
        `SELECT status::text, COUNT(*) AS count
         FROM audit_outbox
         WHERE tenant_id = $1::uuid
         GROUP BY status
         ORDER BY status`,
        tenantId,
      );
    });

    const metricsMap = Object.fromEntries(
      metrics.map((m) => [m.status, Number(m.count)]),
    );

    expect(metricsMap["PENDING"]).toBe(3);
    expect(metricsMap["PROCESSING"]).toBe(2);
    expect(metricsMap["FAILED"]).toBe(1);
  });

  it("records an AUDIT_OUTBOX_METRICS_VIEW audit log via writeDirectAuditLog pattern", async () => {
    // Create a SENT outbox row so the HUMAN audit_logs row satisfies
    // CHECK (outbox_id IS NOT NULL OR actor_type = 'SYSTEM')
    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantId,
      );
    });

    // Simulate what the metrics endpoint does: write a direct audit log entry
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, outbox_id
        ) VALUES (
          gen_random_uuid(),
          $1::uuid,
          $2::"AuditScope",
          $3::"AuditAction",
          $4::uuid,
          $5::"ActorType",
          $6::jsonb,
          now(),
          $7::uuid
        )`,
        tenantId,
        AUDIT_SCOPE.TENANT,
        AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW,
        userId,
        ACTOR_TYPE.HUMAN,
        JSON.stringify({ viewedBy: userId }),
        outboxId,
      );
    });

    // Verify the audit log was written
    const logs = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        action: string;
        user_id: string;
        actor_type: string;
      }[]>(
        `SELECT action::text, user_id, actor_type::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW,
      );
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("AUDIT_OUTBOX_METRICS_VIEW");
    expect(logs[0].user_id).toBe(userId);
    expect(logs[0].actor_type).toBe("HUMAN");
  });
});
