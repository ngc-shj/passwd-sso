/**
 * Phase 3: Worker fan-out — the claim+process pattern correctly joins
 * audit_deliveries with audit_delivery_targets and returns the right
 * target kind and outbox payload for each delivery row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_ACTION, AUDIT_SCOPE, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { deliverRow, deliverRowWithChain, type AuditOutboxRow } from "@/workers/audit-outbox-worker";
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";

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

    // Fetch deliveries with target; outbox is fetched separately (FK removed)
    const deliveries = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.auditDelivery.findMany({
        where: { id: { in: [...claimedIds] } },
        include: { target: true },
      });
    });

    expect(deliveries).toHaveLength(2);

    const outboxIds = [...new Set(deliveries.map((d) => d.outboxId))];
    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.auditOutbox.findMany({
        where: { id: { in: outboxIds } },
        select: { id: true, payload: true },
      });
    });
    const outboxById = new Map(outboxRows.map((o) => [o.id, o]));

    const whDelivery = deliveries.find((d) => d.id === whDeliveryId)!;
    expect(whDelivery.target.kind).toBe("WEBHOOK");
    expect(whDelivery.outboxId).toBe(outboxId);
    const whOutbox = outboxById.get(whDelivery.outboxId)!;
    expect(whOutbox.id).toBe(outboxId);
    expect((whOutbox.payload as Record<string, unknown>).action).toBe("ENTRY_CREATE");

    const s3Delivery = deliveries.find((d) => d.id === s3DeliveryId)!;
    expect(s3Delivery.target.kind).toBe("S3_OBJECT");
    expect(s3Delivery.outboxId).toBe(outboxId);
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

// ─── Finding M2: durable audit-delivery enqueue ─────────────────────────────
//
// deliverRow / deliverRowWithChain must create the audit_deliveries work rows
// INSIDE the winning audit tx (like the webhook enqueue), not via a post-commit
// fire-and-forget. A crash after the audit commit but before the fan-out used to
// lose the delivery rows permanently; now the rows are durable and idempotent.
describe("audit-outbox worker fan-out — durable in-tx audit-delivery enqueue (Finding M2)", () => {
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

  async function insertActiveTarget(kind: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
          id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
          master_key_version, is_active, created_at
        ) VALUES ($1::uuid, $2::uuid, $3::"AuditDeliveryTargetKind", 'enc', 'iv', 'tag', 1, true, now())`,
        id,
        tenantId,
        kind,
      );
    });
    return id;
  }

  async function insertPendingOutboxRow(payload: AuditOutboxPayload): Promise<AuditOutboxRow> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', 0, 8, now(), now())`,
        id,
        tenantId,
        JSON.stringify(payload),
      );
    });
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<AuditOutboxRow[]>(
        `SELECT id, tenant_id, payload, status, attempt_count, max_attempts,
                created_at, next_retry_at, processing_started_at, sent_at, last_error
         FROM audit_outbox WHERE id = $1::uuid`,
        id,
      );
    });
    return rows[0]!;
  }

  async function deliveriesForOutbox(outboxId: string) {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ id: string; target_id: string; status: string }>>(
        `SELECT id, target_id::text AS target_id, status::text AS status
         FROM audit_deliveries WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
  }

  async function webhookDeliveriesForOutbox(outboxId: string) {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        `SELECT id, status::text AS status
         FROM webhook_deliveries WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
  }

  const payload = (): AuditOutboxPayload =>
    ({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE,
      userId,
      actorType: ACTOR_TYPE.HUMAN,
      serviceAccountId: null,
      teamId: null,
      targetType: null,
      targetId: null,
      metadata: { note: "m2" },
      ip: null,
      userAgent: null,
    }) as AuditOutboxPayload;

  it("deliverRow enqueues one PENDING audit_deliveries row per active non-DB target, atomically with the audit_logs INSERT", async () => {
    const webhookTargetId = await insertActiveTarget("WEBHOOK");
    const siemTargetId = await insertActiveTarget("SIEM_HEC");
    const p = payload();
    const row = await insertPendingOutboxRow(p);

    const res = await deliverRow(ctx.su.prisma, row, p);
    expect(res.inserted).toBe(true);

    const deliveries = await deliveriesForOutbox(row.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === "PENDING")).toBe(true);
    expect(new Set(deliveries.map((d) => d.target_id))).toEqual(
      new Set([webhookTargetId, siemTargetId]),
    );
  });

  it("does NOT enqueue an audit_deliveries row for a DB-kind target (DB is the outbox itself)", async () => {
    await insertActiveTarget("DB");
    const p = payload();
    const row = await insertPendingOutboxRow(p);

    const res = await deliverRow(ctx.su.prisma, row, p);
    expect(res.inserted).toBe(true);

    expect(await deliveriesForOutbox(row.id)).toHaveLength(0);
  });

  it("a reaper-style re-delivery (inserted=false) does not enqueue delivery rows — the inserted gate, not just skipDuplicates (idempotent)", async () => {
    await insertActiveTarget("WEBHOOK");
    const p = payload();
    const row = await insertPendingOutboxRow(p);

    const first = await deliverRow(ctx.su.prisma, row, p);
    expect(first.inserted).toBe(true);
    expect(await deliveriesForOutbox(row.id)).toHaveLength(1);

    // Reset the outbox row to PENDING so the second deliverRow re-runs the same
    // path; the audit_logs ON CONFLICT (outbox_id) makes this call a loser
    // (inserted=false), so it must NOT re-enqueue.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'PENDING', sent_at = NULL WHERE id = $1::uuid`,
        row.id,
      );
    });

    // Add a SECOND active target between the two deliver calls. If the loser
    // still ran enqueueAuditDeliveriesInTx, it would create a NEW delivery row
    // for this new target (skipDuplicates would NOT suppress it — different
    // target_id). So a second row appearing here isolates the `inserted > 0`
    // gate from the createMany skipDuplicates dedup.
    const lateTargetId = await insertActiveTarget("SIEM_HEC");

    const second = await deliverRow(ctx.su.prisma, row, p);
    expect(second.inserted).toBe(false);
    const after = await deliveriesForOutbox(row.id);
    expect(after).toHaveLength(1);
    expect(after.map((d) => d.target_id)).not.toContain(lateTargetId);
  });

  it("deliverRowWithChain (chain-enabled tenant) also enqueues one PENDING audit_deliveries row per active non-DB target, in the winning tx", async () => {
    // Chain path has its own enqueueAuditDeliveriesInTx call — cover it too, not
    // only the non-chain deliverRow path.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantId,
      );
    });
    const webhookTargetId = await insertActiveTarget("WEBHOOK");
    const siemTargetId = await insertActiveTarget("SIEM_HEC");
    const p = payload();
    const row = await insertPendingOutboxRow(p);

    const res = await deliverRowWithChain(ctx.su.prisma, row, p);
    expect(res.delivered).toBe(true);
    expect(res.inserted).toBe(true);

    const deliveries = await deliveriesForOutbox(row.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === "PENDING")).toBe(true);
    expect(new Set(deliveries.map((d) => d.target_id))).toEqual(
      new Set([webhookTargetId, siemTargetId]),
    );
  });

  it("M2 rollback: if enqueueAuditDeliveriesInTx throws, the whole winning tx rolls back (no audit_logs row, no audit_deliveries, outbox NOT marked SENT)", async () => {
    // The load-bearing durability property of M2: the delivery enqueue lives in
    // the SAME tx as the audit_logs INSERT + outbox SENT update. Inject a fault
    // into the createMany that enqueueAuditDeliveriesInTx issues (never by
    // editing the worker) and assert the entire tx rolls back.
    await insertActiveTarget("WEBHOOK");
    const p = payload();
    const row = await insertPendingOutboxRow(p);

    const injected = new Error("injected: audit_deliveries createMany failure");
    const proxy = new Proxy(ctx.su.prisma, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (fn: (tx: any) => unknown, ...rest: unknown[]) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (target.$transaction as any)((tx: any) => {
              const txProxy = new Proxy(tx, {
                get(t, pp, rr) {
                  if (pp === "auditDelivery") {
                    return new Proxy(t.auditDelivery, {
                      get(model, mp, mr) {
                        if (mp === "createMany") {
                          return () => Promise.reject(injected);
                        }
                        return Reflect.get(model, mp, mr);
                      },
                    });
                  }
                  return Reflect.get(t, pp, rr);
                },
              });
              return fn(txProxy);
            }, ...rest);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as PrismaClient;

    await expect(deliverRow(proxy, row, p)).rejects.toThrow(injected);

    // audit_logs INSERT rolled back — no row for this outbox.
    const auditLogs = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE outbox_id = $1::uuid`,
        row.id,
      );
    });
    expect(Number(auditLogs[0]?.n ?? 0)).toBe(0);

    // No audit_deliveries rows.
    expect(await deliveriesForOutbox(row.id)).toHaveLength(0);

    // The webhook enqueue (enqueueWebhookDeliveryInTx) runs earlier in the SAME
    // winning tx, so its row must have rolled back too — proving the atomicity
    // spans both enqueue kinds, not just audit_deliveries.
    expect(await webhookDeliveriesForOutbox(row.id)).toHaveLength(0);

    // Outbox row survived and stayed PENDING (deliverRow marks SENT only at the
    // end of the winning tx; rollback leaves the pre-call PENDING state). Assert
    // the row still exists so optional-chaining can't mask a vanished row.
    const outbox = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status::text AS status FROM audit_outbox WHERE id = $1::uuid`,
        row.id,
      );
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.status).toBe("PENDING");
  });
});
