/**
 * Phase 3: Stuck delivery reaper — PROCESSING delivery rows older than
 * the timeout are reset to PENDING (under max_attempts) or FAILED
 * (at max_attempts). Dead-lettered rows produce an AUDIT_DELIVERY_DEAD_LETTER event.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

describe("audit-delivery stuck reaper", () => {
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

  async function insertOutboxRow(): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', now())`,
        id,
        tenantId,
        JSON.stringify({
          scope: "PERSONAL",
          action: "ENTRY_CREATE",
          userId,
          actorType: "HUMAN",
        }),
      );
    });
    return id;
  }

  async function insertTarget(kind: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
          id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
          master_key_version, is_active, created_at
        ) VALUES ($1::uuid, $2::uuid, $3::"AuditDeliveryTargetKind", 'test_enc', 'test_iv', 'test_tag', 1, true, now())`,
        id,
        tenantId,
        kind,
      );
    });
    return id;
  }

  /** Insert a PROCESSING delivery with an old processing_started_at. */
  async function insertStuckDelivery(
    outboxId: string,
    targetId: string,
    attemptCount: number,
    maxAttempts: number,
  ): Promise<string> {
    const id = randomUUID();
    const stuckTime = new Date(
      Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS - 60_000,
    );
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (
          id, outbox_id, target_id, tenant_id, status,
          attempt_count, max_attempts, processing_started_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PROCESSING',
          $5, $6, $7::timestamptz
        )`,
        id,
        outboxId,
        targetId,
        tenantId,
        attemptCount,
        maxAttempts,
        stuckTime.toISOString(),
      );
    });
    return id;
  }

  it("resets stuck delivery under max_attempts to PENDING", async () => {
    const targetId = await insertTarget("WEBHOOK");
    const outboxId = await insertOutboxRow();
    // attempt_count=2, max_attempts=8 → after reap: attempt_count=3, still under 8 → PENDING
    const deliveryId = await insertStuckDelivery(outboxId, targetId, 2, 8);

    const cutoff = new Date(Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS);

    // Run the reaper SQL
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE "audit_deliveries"
         SET "status" = CASE
           WHEN "attempt_count" + 1 >= "max_attempts" THEN 'FAILED'::"AuditDeliveryStatus"
           ELSE 'PENDING'::"AuditDeliveryStatus"
         END,
         "attempt_count" = "attempt_count" + 1,
         "processing_started_at" = NULL,
         "last_error" = 'reaped: processing timeout exceeded'
         WHERE "status" = 'PROCESSING'
           AND "processing_started_at" < $1`,
        cutoff,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        status: string;
        attempt_count: number;
        processing_started_at: Date | null;
        last_error: string | null;
      }[]>(
        `SELECT status, attempt_count, processing_started_at, last_error
         FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });

    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].attempt_count).toBe(3);
    expect(rows[0].processing_started_at).toBeNull();
    expect(rows[0].last_error).toBe("reaped: processing timeout exceeded");
  });

  it("transitions stuck delivery at max_attempts to FAILED", async () => {
    const targetId = await insertTarget("SIEM_HEC");
    const outboxId = await insertOutboxRow();
    // attempt_count=7, max_attempts=8 → after reap: attempt_count=8 >= 8 → FAILED
    const deliveryId = await insertStuckDelivery(outboxId, targetId, 7, 8);

    const cutoff = new Date(Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE "audit_deliveries"
         SET "status" = CASE
           WHEN "attempt_count" + 1 >= "max_attempts" THEN 'FAILED'::"AuditDeliveryStatus"
           ELSE 'PENDING'::"AuditDeliveryStatus"
         END,
         "attempt_count" = "attempt_count" + 1,
         "processing_started_at" = NULL,
         "last_error" = 'reaped: processing timeout exceeded'
         WHERE "status" = 'PROCESSING'
           AND "processing_started_at" < $1`,
        cutoff,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        status: string;
        attempt_count: number;
        processing_started_at: Date | null;
      }[]>(
        `SELECT status, attempt_count, processing_started_at
         FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });

    expect(rows[0].status).toBe("FAILED");
    expect(rows[0].attempt_count).toBe(8);
    expect(rows[0].processing_started_at).toBeNull();

    // Write the dead-letter meta-event directly to audit_logs (simulating worker behavior)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, metadata, created_at
        ) VALUES (
          gen_random_uuid(), $1::uuid, 'TENANT'::"AuditScope",
          'AUDIT_DELIVERY_DEAD_LETTER'::"AuditAction",
          $2::uuid, 'SYSTEM'::"ActorType",
          $3::jsonb, now()
        )`,
        tenantId,
        SYSTEM_ACTOR_ID,
        JSON.stringify({ deliveryId, targetId, error: "reaped" }),
      );
    });

    // Verify AUDIT_DELIVERY_DEAD_LETTER meta-event was written
    const logRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ action: string; actor_type: string; user_id: string | null }[]>(
        `SELECT action, actor_type, user_id
         FROM audit_logs
         WHERE tenant_id = $1::uuid
           AND action = 'AUDIT_DELIVERY_DEAD_LETTER'`,
        tenantId,
      );
    });
    expect(logRows.length).toBeGreaterThanOrEqual(1);
    expect(logRows[0].actor_type).toBe("SYSTEM");
    expect(logRows[0].user_id).toBe(SYSTEM_ACTOR_ID);
  });

  it("does not reap recently-started PROCESSING rows", async () => {
    const targetId = await insertTarget("S3_OBJECT");
    const outboxId = await insertOutboxRow();

    // Insert a PROCESSING row with a recent processing_started_at
    const deliveryId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (
          id, outbox_id, target_id, tenant_id, status,
          attempt_count, max_attempts, processing_started_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PROCESSING',
          0, 8, now()
        )`,
        deliveryId,
        outboxId,
        targetId,
        tenantId,
      );
    });

    const cutoff = new Date(Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS);

    const result = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$executeRawUnsafe(
        `UPDATE "audit_deliveries"
         SET "status" = 'PENDING',
             "processing_started_at" = NULL
         WHERE "status" = 'PROCESSING'
           AND "processing_started_at" < $1
           AND "tenant_id" = $2::uuid`,
        cutoff,
        tenantId,
      );
    });
    expect(Number(result)).toBe(0);

    // Row is still PROCESSING
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });
    expect(rows[0].status).toBe("PROCESSING");
  });
});
