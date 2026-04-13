/**
 * Phase 3: Rate-limit simulation — when more delivery rows exist than
 * can be processed in one batch, the excess remain PENDING with a
 * future nextRetryAt after a simulated rate-limited retry.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

describe("audit-delivery rate limit", () => {
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

  it("processes a partial batch; remaining rows stay PENDING", async () => {
    const targetId = await insertTarget("WEBHOOK");
    const deliveryIds: string[] = [];

    // Create 5 PENDING delivery rows for the same target, each linked to a different outbox row
    for (let i = 0; i < 5; i++) {
      const outboxId = await insertOutboxRow();
      const dId = randomUUID();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
          dId,
          outboxId,
          targetId,
          tenantId,
        );
      });
      deliveryIds.push(dId);
    }

    // Claim only the first 2 (simulating a small batch)
    const claimed = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "audit_deliveries"
         SET "status" = 'PROCESSING', "processing_started_at" = now()
         WHERE "id" IN (
           SELECT "id" FROM "audit_deliveries"
           WHERE "status" = 'PENDING' AND "tenant_id" = $1::uuid
           ORDER BY "created_at" ASC
           LIMIT 2
           FOR UPDATE SKIP LOCKED
         )
         AND "status" = 'PENDING'
         RETURNING "id"`,
        tenantId,
      );
    });
    expect(claimed).toHaveLength(2);

    // Mark claimed rows as SENT
    for (const c of claimed) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `UPDATE audit_deliveries SET status = 'SENT' WHERE id = $1::uuid`,
          c.id,
        );
      });
    }

    // Remaining 3 should still be PENDING
    const remaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string; status: string }[]>(
        `SELECT id, status FROM audit_deliveries
         WHERE tenant_id = $1::uuid AND status = 'PENDING'`,
        tenantId,
      );
    });
    expect(remaining).toHaveLength(3);
  });

  it("rate-limited retry sets future nextRetryAt on remaining rows", async () => {
    const targetId = await insertTarget("SIEM_HEC");
    const outboxId = await insertOutboxRow();

    const deliveryId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        deliveryId,
        outboxId,
        targetId,
        tenantId,
      );
    });

    // Simulate a rate-limited failure: increment attempt, set future nextRetryAt
    const futureRetry = new Date(Date.now() + 60_000); // 1 minute from now
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_deliveries
         SET status = 'PENDING',
             attempt_count = attempt_count + 1,
             next_retry_at = $1::timestamptz,
             last_error = '429 Too Many Requests'
         WHERE id = $2::uuid`,
        futureRetry.toISOString(),
        deliveryId,
      );
    });

    // Verify the row is PENDING but not claimable (nextRetryAt in the future)
    const claimable = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_deliveries
         WHERE status = 'PENDING' AND next_retry_at <= now() AND tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(claimable).toHaveLength(0);

    // But the row is still PENDING
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        status: string;
        attempt_count: number;
        last_error: string | null;
      }[]>(
        `SELECT status, attempt_count, last_error FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].attempt_count).toBe(1);
    expect(rows[0].last_error).toBe("429 Too Many Requests");
  });
});
