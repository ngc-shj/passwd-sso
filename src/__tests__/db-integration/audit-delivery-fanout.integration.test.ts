/**
 * Phase 3: Fan-out — one outbox row creates N audit_deliveries rows,
 * one per active delivery target. Duplicate inserts are skipped via
 * the @@unique([outboxId, targetId]) constraint.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

describe("audit-delivery fan-out", () => {
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

  /** Insert an outbox row in SENT status (as if the worker already delivered to audit_logs). */
  async function insertSentOutboxRow(): Promise<string> {
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

  /** Insert an active delivery target with placeholder encrypted config. */
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

  it("creates one delivery row per active target", async () => {
    const [webhookId, siemId, s3Id] = await Promise.all([
      insertTarget("WEBHOOK"),
      insertTarget("SIEM_HEC"),
      insertTarget("S3_OBJECT"),
    ]);
    const outboxId = await insertSentOutboxRow();

    // Fan-out: insert one delivery per active non-DB target
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const targets = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_delivery_targets
         WHERE tenant_id = $1::uuid AND is_active = true AND kind != 'DB'`,
        tenantId,
      );
      expect(targets).toHaveLength(3);

      for (const t of targets) {
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
          randomUUID(),
          outboxId,
          t.id,
          tenantId,
        );
      }
    });

    // Verify: exactly 3 PENDING delivery rows
    const deliveries = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string; target_id: string; status: string }[]>(
        `SELECT id, target_id, status FROM audit_deliveries
         WHERE outbox_id = $1::uuid ORDER BY target_id`,
        outboxId,
      );
    });

    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((d) => d.status === "PENDING")).toBe(true);

    const targetIds = new Set(deliveries.map((d) => d.target_id));
    expect(targetIds).toEqual(new Set([webhookId, siemId, s3Id]));
  });

  it("skips duplicate delivery via unique constraint", async () => {
    const targetId = await insertTarget("WEBHOOK");
    const outboxId = await insertSentOutboxRow();

    // First insert
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        randomUUID(),
        outboxId,
        targetId,
        tenantId,
      );
    });

    // Duplicate insert with ON CONFLICT DO NOTHING
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')
         ON CONFLICT (outbox_id, target_id) DO NOTHING`,
        randomUUID(),
        outboxId,
        targetId,
        tenantId,
      );
    });

    // Still exactly 1 row
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_deliveries
         WHERE outbox_id = $1::uuid AND target_id = $2::uuid`,
        outboxId,
        targetId,
      );
    });
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it("rejects duplicate delivery without ON CONFLICT (raw constraint)", async () => {
    const targetId = await insertTarget("WEBHOOK");
    const outboxId = await insertSentOutboxRow();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        randomUUID(),
        outboxId,
        targetId,
        tenantId,
      );
    });

    // Without ON CONFLICT — the unique constraint should reject
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
          randomUUID(),
          outboxId,
          targetId,
          tenantId,
        );
      }),
    ).rejects.toThrow();
  });
});
