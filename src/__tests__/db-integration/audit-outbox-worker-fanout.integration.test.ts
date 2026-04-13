/**
 * Phase 3: Worker fan-out — the claim+process pattern correctly joins
 * audit_deliveries with audit_delivery_targets and returns the right
 * target kind and outbox payload for each delivery row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

describe("audit-outbox worker fan-out (DB join)", () => {
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

  async function insertOutboxRow(payload: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', now())`,
        id,
        tenantId,
        JSON.stringify(payload),
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

  async function insertDelivery(outboxId: string, targetId: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        id,
        outboxId,
        targetId,
        tenantId,
      );
    });
    return id;
  }

  it("claim+fetch joins deliveries with their target and outbox data", async () => {
    const webhookTargetId = await insertTarget("WEBHOOK");
    const s3TargetId = await insertTarget("S3_OBJECT");

    const payload = {
      scope: "PERSONAL",
      action: "ENTRY_CREATE",
      userId,
      actorType: "HUMAN",
    };
    const outboxId = await insertOutboxRow(payload);

    const whDeliveryId = await insertDelivery(outboxId, webhookTargetId);
    const s3DeliveryId = await insertDelivery(outboxId, s3TargetId);

    // Simulate the claim: UPDATE to PROCESSING, then SELECT with join
    const claimed = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const ids = await tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "audit_deliveries"
         SET "status" = 'PROCESSING',
             "processing_started_at" = now()
         WHERE "id" IN (
           SELECT "id" FROM "audit_deliveries"
           WHERE "status" = 'PENDING'
             AND "next_retry_at" <= now()
             AND "tenant_id" = $1::uuid
           ORDER BY "created_at" ASC
           FOR UPDATE SKIP LOCKED
         )
         AND "status" = 'PENDING'
         RETURNING "id"`,
        tenantId,
      );
      return ids;
    });

    expect(claimed).toHaveLength(2);
    const claimedIds = new Set(claimed.map((r) => r.id));
    expect(claimedIds).toContain(whDeliveryId);
    expect(claimedIds).toContain(s3DeliveryId);

    // Fetch with Prisma include to verify the join works
    const deliveries = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.auditDelivery.findMany({
        where: { id: { in: [...claimedIds] } },
        include: { target: true, outbox: true },
      });
    });

    expect(deliveries).toHaveLength(2);

    const whDelivery = deliveries.find((d) => d.id === whDeliveryId)!;
    expect(whDelivery.target.kind).toBe("WEBHOOK");
    expect(whDelivery.outbox.id).toBe(outboxId);
    expect((whDelivery.outbox.payload as Record<string, unknown>).action).toBe("ENTRY_CREATE");

    const s3Delivery = deliveries.find((d) => d.id === s3DeliveryId)!;
    expect(s3Delivery.target.kind).toBe("S3_OBJECT");
    expect(s3Delivery.outbox.id).toBe(outboxId);
  });

  it("claimed rows are in PROCESSING status and not re-claimable", async () => {
    const targetId = await insertTarget("SIEM_HEC");
    const outboxId = await insertOutboxRow({
      scope: "TENANT",
      action: "POLICY_UPDATE",
      userId: null,
      actorType: "SYSTEM",
    });
    await insertDelivery(outboxId, targetId);

    // First claim
    const first = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "audit_deliveries"
         SET "status" = 'PROCESSING', "processing_started_at" = now()
         WHERE "id" IN (
           SELECT "id" FROM "audit_deliveries"
           WHERE "status" = 'PENDING' AND "tenant_id" = $1::uuid
           FOR UPDATE SKIP LOCKED
         )
         AND "status" = 'PENDING'
         RETURNING "id"`,
        tenantId,
      );
    });
    expect(first).toHaveLength(1);

    // Second claim — should return 0 (already PROCESSING)
    const second = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "audit_deliveries"
         SET "status" = 'PROCESSING', "processing_started_at" = now()
         WHERE "id" IN (
           SELECT "id" FROM "audit_deliveries"
           WHERE "status" = 'PENDING' AND "tenant_id" = $1::uuid
           FOR UPDATE SKIP LOCKED
         )
         AND "status" = 'PENDING'
         RETURNING "id"`,
        tenantId,
      );
    });
    expect(second).toHaveLength(0);
  });
});
