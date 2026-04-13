/**
 * Phase 3: Retention purge — outbox rows with pending deliveries are NOT
 * purged. Terminal delivery rows (SENT/FAILED) past retention are purged.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX } from "@/lib/constants/audit";

describe("audit-delivery retention purge", () => {
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

  /** Insert a SENT outbox row with a custom sent_at timestamp. */
  async function insertSentOutboxRow(sentAt: Date): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', $4::timestamptz, $4::timestamptz)`,
        id,
        tenantId,
        JSON.stringify({
          scope: "PERSONAL",
          action: "ENTRY_CREATE",
          userId,
          actorType: "HUMAN",
        }),
        sentAt.toISOString(),
      );
    });
    return id;
  }

  /** Insert a delivery row with a custom created_at. */
  async function insertDelivery(
    outboxId: string,
    targetId: string,
    status: string,
    createdAt: Date,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (
          id, outbox_id, target_id, tenant_id, status, created_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"AuditDeliveryStatus", $6::timestamptz
        )`,
        id,
        outboxId,
        targetId,
        tenantId,
        status,
        createdAt.toISOString(),
      );
    });
    return id;
  }

  it("outbox row with a PENDING delivery survives retention purge", async () => {
    const retentionMs = AUDIT_OUTBOX.RETENTION_HOURS * 3_600_000;
    const oldDate = new Date(Date.now() - retentionMs - 60_000);
    const targetId = await insertTarget("WEBHOOK");

    // SENT outbox row past retention, but has a PENDING delivery
    const outboxId = await insertSentOutboxRow(oldDate);
    await insertDelivery(outboxId, targetId, "PENDING", oldDate);

    // Run the retention purge SQL (same as the worker)
    const retentionHours = AUDIT_OUTBOX.RETENTION_HOURS;
    const failedRetentionDays = AUDIT_OUTBOX.FAILED_RETENTION_DAYS;

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox
         WHERE (
           status = 'SENT'
           AND sent_at < now() - make_interval(hours => $1)
           AND NOT EXISTS (
             SELECT 1 FROM "audit_deliveries"
             WHERE "audit_deliveries"."outbox_id" = "audit_outbox"."id"
               AND "audit_deliveries"."status" IN ('PENDING', 'PROCESSING')
           )
         )
         OR (status = 'FAILED' AND created_at < now() - make_interval(days => $2))`,
        retentionHours,
        failedRetentionDays,
      );
    });

    // Outbox row should survive
    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
    expect(Number(outboxRows[0].cnt)).toBe(1);
  });

  it("outbox row without pending deliveries is purged past retention", async () => {
    const retentionMs = AUDIT_OUTBOX.RETENTION_HOURS * 3_600_000;
    const oldDate = new Date(Date.now() - retentionMs - 60_000);
    const targetId = await insertTarget("S3_OBJECT");

    // SENT outbox row past retention with only a SENT delivery (no pending)
    const outboxId = await insertSentOutboxRow(oldDate);
    await insertDelivery(outboxId, targetId, "SENT", oldDate);

    const retentionHours = AUDIT_OUTBOX.RETENTION_HOURS;
    const failedRetentionDays = AUDIT_OUTBOX.FAILED_RETENTION_DAYS;

    // First purge deliveries to avoid FK constraint (deliveries have onDelete: Restrict)
    const sentCutoff = new Date(Date.now() - retentionMs);
    const failedCutoff = new Date(Date.now() - failedRetentionDays * 86_400_000);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM "audit_deliveries"
         WHERE ("status" = 'SENT' AND "created_at" < $1)
            OR ("status" = 'FAILED' AND "created_at" < $2)`,
        sentCutoff,
        failedCutoff,
      );
    });

    // Now purge outbox
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox
         WHERE (
           status = 'SENT'
           AND sent_at < now() - make_interval(hours => $1)
           AND NOT EXISTS (
             SELECT 1 FROM "audit_deliveries"
             WHERE "audit_deliveries"."outbox_id" = "audit_outbox"."id"
               AND "audit_deliveries"."status" IN ('PENDING', 'PROCESSING')
           )
         )
         OR (status = 'FAILED' AND created_at < now() - make_interval(days => $2))`,
        retentionHours,
        failedRetentionDays,
      );
    });

    // Outbox row should be purged
    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });
    expect(Number(outboxRows[0].cnt)).toBe(0);
  });

  it("terminal delivery rows past retention are purged", async () => {
    const retentionMs = AUDIT_OUTBOX.RETENTION_HOURS * 3_600_000;
    const oldDate = new Date(Date.now() - retentionMs - 60_000);
    const targetId = await insertTarget("WEBHOOK");
    const outboxId = await insertSentOutboxRow(oldDate);

    const sentDeliveryId = await insertDelivery(outboxId, targetId, "SENT", oldDate);
    const failedDeliveryId = await insertDelivery(
      outboxId,
      // Need a different target for the unique constraint
      await insertTarget("SIEM_HEC"),
      "FAILED",
      oldDate,
    );

    const sentCutoff = new Date(Date.now() - retentionMs);
    const failedCutoff = new Date(Date.now() - AUDIT_OUTBOX.FAILED_RETENTION_DAYS * 86_400_000);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM "audit_deliveries"
         WHERE ("status" = 'SENT' AND "created_at" < $1)
            OR ("status" = 'FAILED' AND "created_at" < $2)`,
        sentCutoff,
        failedCutoff,
      );
    });

    // SENT delivery should be purged (old enough)
    const sentRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_deliveries WHERE id = $1::uuid`,
        sentDeliveryId,
      );
    });
    expect(Number(sentRows[0].cnt)).toBe(0);

    // FAILED delivery: only purged if older than FAILED_RETENTION_DAYS.
    // Our oldDate is only RETENTION_HOURS old, so if FAILED_RETENTION_DAYS >> RETENTION_HOURS,
    // the FAILED row should still exist.
    const failedRetentionMs = AUDIT_OUTBOX.FAILED_RETENTION_DAYS * 86_400_000;
    const failedShouldBePurged = Date.now() - oldDate.getTime() > failedRetentionMs;

    const failedRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_deliveries WHERE id = $1::uuid`,
        failedDeliveryId,
      );
    });

    if (failedShouldBePurged) {
      expect(Number(failedRows[0].cnt)).toBe(0);
    } else {
      // FAILED retention is 90 days; the row is only hours old — should survive
      expect(Number(failedRows[0].cnt)).toBe(1);
    }
  });

  it("recent SENT delivery rows are NOT purged", async () => {
    const targetId = await insertTarget("WEBHOOK");
    const recentDate = new Date(); // now
    const outboxId = await insertSentOutboxRow(recentDate);
    const deliveryId = await insertDelivery(outboxId, targetId, "SENT", recentDate);

    const retentionMs = AUDIT_OUTBOX.RETENTION_HOURS * 3_600_000;
    const sentCutoff = new Date(Date.now() - retentionMs);
    const failedCutoff = new Date(Date.now() - AUDIT_OUTBOX.FAILED_RETENTION_DAYS * 86_400_000);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM "audit_deliveries"
         WHERE ("status" = 'SENT' AND "created_at" < $1)
            OR ("status" = 'FAILED' AND "created_at" < $2)`,
        sentCutoff,
        failedCutoff,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });
    expect(Number(rows[0].cnt)).toBe(1);
  });
});
