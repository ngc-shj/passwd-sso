/**
 * Phase 3: Stuck delivery reaper — PROCESSING delivery rows older than
 * the timeout are reset to PENDING (under max_attempts) or FAILED
 * (at max_attempts).
 *
 * T3: exercises the REAL exported reapStuckDeliveries (not duplicated SQL).
 * Note: reapStuckDeliveries itself does not write an audit_logs event —
 * dead-letter audit emission for deliveries happens in recordDeliveryError
 * (a separate, non-reaper code path), so this file only asserts row state.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
import { reapStuckDeliveries } from "@/workers/audit-outbox-worker";

describe("audit-delivery stuck reaper (T3 real reapStuckDeliveries)", () => {
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

  /** Insert a PROCESSING delivery with an old (or fresh) processing_started_at. */
  async function insertDelivery(opts: {
    outboxId: string;
    targetId: string;
    attemptCount: number;
    maxAttempts: number;
    stuck: boolean;
  }): Promise<string> {
    const id = randomUUID();
    const processingStartedAt = opts.stuck
      ? new Date(Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS - 60_000)
      : new Date();
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
        opts.outboxId,
        opts.targetId,
        tenantId,
        opts.attemptCount,
        opts.maxAttempts,
        processingStartedAt.toISOString(),
      );
    });
    return id;
  }

  async function getDelivery(deliveryId: string) {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        {
          status: string;
          attempt_count: number;
          processing_started_at: Date | null;
          last_error: string | null;
        }[]
      >(
        `SELECT status::text, attempt_count, processing_started_at, last_error
         FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });
    return rows[0];
  }

  it("resets stuck delivery under max_attempts to PENDING", async () => {
    const targetId = await insertTarget("WEBHOOK");
    const outboxId = await insertOutboxRow();
    // attempt_count=2, max_attempts=8 → after reap: attempt_count=3, still under 8 → PENDING
    const deliveryId = await insertDelivery({
      outboxId,
      targetId,
      attemptCount: 2,
      maxAttempts: 8,
      stuck: true,
    });

    const reapedCount = await reapStuckDeliveries(ctx.su.prisma);
    expect(reapedCount).toBeGreaterThanOrEqual(1);

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("PENDING");
    expect(row.attempt_count).toBe(3);
    expect(row.processing_started_at).toBeNull();
    expect(row.last_error).toBe("reaped: processing timeout exceeded");
  });

  it("transitions stuck delivery at max_attempts to FAILED", async () => {
    const targetId = await insertTarget("SIEM_HEC");
    const outboxId = await insertOutboxRow();
    // attempt_count=7, max_attempts=8 → after reap: attempt_count=8 >= 8 → FAILED
    const deliveryId = await insertDelivery({
      outboxId,
      targetId,
      attemptCount: 7,
      maxAttempts: 8,
      stuck: true,
    });

    await reapStuckDeliveries(ctx.su.prisma);

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("FAILED");
    expect(row.attempt_count).toBe(8);
    expect(row.processing_started_at).toBeNull();
  });

  it("does not reap recently-started PROCESSING rows", async () => {
    const targetId = await insertTarget("S3_OBJECT");
    const outboxId = await insertOutboxRow();
    const deliveryId = await insertDelivery({
      outboxId,
      targetId,
      attemptCount: 0,
      maxAttempts: 8,
      stuck: false,
    });

    await reapStuckDeliveries(ctx.su.prisma);

    const row = await getDelivery(deliveryId);
    expect(row.status).toBe("PROCESSING");
  });
});
