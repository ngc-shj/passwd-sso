/**
 * Phase 3: Failure isolation — SIEM target failure does not block
 * S3 target success. Each delivery row transitions independently.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

describe("audit-delivery failure isolation", () => {
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

  it("one target FAILED does not prevent another from transitioning to SENT", async () => {
    const siemTargetId = await insertTarget("SIEM_HEC");
    const s3TargetId = await insertTarget("S3_OBJECT");
    const outboxId = await insertOutboxRow();

    const siemDeliveryId = await insertDelivery(outboxId, siemTargetId);
    const s3DeliveryId = await insertDelivery(outboxId, s3TargetId);

    // Mark SIEM delivery as FAILED
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_deliveries
         SET status = 'FAILED', last_error = 'connection timeout'
         WHERE id = $1::uuid`,
        siemDeliveryId,
      );
    });

    // Mark S3 delivery as SENT — should succeed independently
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_deliveries SET status = 'SENT' WHERE id = $1::uuid`,
        s3DeliveryId,
      );
    });

    // Verify independent statuses
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string; status: string }[]>(
        `SELECT id, status FROM audit_deliveries WHERE outbox_id = $1::uuid ORDER BY id`,
        outboxId,
      );
    });

    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[siemDeliveryId]).toBe("FAILED");
    expect(byId[s3DeliveryId]).toBe("SENT");
  });

  it("FAILED delivery retains its error message while sibling is SENT", async () => {
    const webhookTargetId = await insertTarget("WEBHOOK");
    const s3TargetId = await insertTarget("S3_OBJECT");
    const outboxId = await insertOutboxRow();

    const whDeliveryId = await insertDelivery(outboxId, webhookTargetId);
    const s3DeliveryId = await insertDelivery(outboxId, s3TargetId);

    const errorMsg = "HTTP 502 Bad Gateway";
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_deliveries
         SET status = 'FAILED', attempt_count = 8, last_error = $1
         WHERE id = $2::uuid`,
        errorMsg,
        whDeliveryId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE audit_deliveries SET status = 'SENT' WHERE id = $1::uuid`,
        s3DeliveryId,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string; status: string; last_error: string | null }[]>(
        `SELECT id, status, last_error FROM audit_deliveries WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });

    const whRow = rows.find((r) => r.id === whDeliveryId)!;
    const s3Row = rows.find((r) => r.id === s3DeliveryId)!;

    expect(whRow.status).toBe("FAILED");
    expect(whRow.last_error).toBe(errorMsg);
    expect(s3Row.status).toBe("SENT");
    expect(s3Row.last_error).toBeNull();
  });
});
