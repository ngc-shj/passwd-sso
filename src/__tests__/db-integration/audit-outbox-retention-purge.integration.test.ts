/**
 * The audit-outbox retention purge, through the production branches the worker
 * runs (purgeSentAgedInTx / purgeFailedAgedInTx), never a copy of their SQL: a
 * copy keeps passing when production gains or loses a predicate.
 *
 * Both branches are global (not tenant-scoped, by design), so they run inside a
 * holding transaction that always rolls back, as in
 * audit-outbox-sweep-caps.integration.test.ts: other tenants' committed aged
 * rows are first moved out of the predicates (AMBIENT), so the counts returned
 * are this test's rows only, and the rollback undoes every write.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { purgeSentAgedInTx, purgeFailedAgedInTx } from "@/workers/audit-outbox-worker";

type PrismaTx = Prisma.TransactionClient;

describe("audit-outbox retention purge", () => {
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

  const makePayload = () =>
    JSON.stringify({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: randomUUID(),
      actorType: ACTOR_TYPE.HUMAN,
    });

  const ROLLBACK = Symbol("rollback");
  async function runInRolledBackTx(body: (tx: PrismaTx) => Promise<void>): Promise<void> {
    try {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await body(tx);
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
  }

  const AMBIENT = [
    `UPDATE audit_outbox SET sent_at = now() WHERE status = 'SENT' AND sent_at < now()`,
    `UPDATE audit_outbox SET created_at = now() WHERE status = 'FAILED' AND created_at < now()`,
  ];

  async function insertSentAged(tx: PrismaTx): Promise<string> {
    const id = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, sent_at)
       VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', 1, 8, now() - interval '48 hours', now(),
               now() - make_interval(hours => $4) - interval '1 hour')`,
      id,
      tenantId,
      makePayload(),
      AUDIT_OUTBOX.RETENTION_HOURS,
    );
    return id;
  }

  async function insertAuditDelivery(tx: PrismaTx, outboxId: string, status: "PENDING" | "PROCESSING"): Promise<void> {
    const targetId = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO audit_delivery_targets (
        id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
        master_key_version, is_active, created_at
      ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK'::"AuditDeliveryTargetKind", 'test_enc', 'test_iv', 'test_tag', 1, true, now())`,
      targetId,
      tenantId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status, next_retry_at, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::"AuditDeliveryStatus", now(), now())`,
      outboxId,
      targetId,
      tenantId,
      status,
    );
  }

  async function insertWebhookDelivery(tx: PrismaTx, outboxId: string, status: "PENDING" | "PROCESSING"): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO webhook_deliveries (id, outbox_id, tenant_id, scope, team_id, action, status, next_retry_at, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'TENANT', NULL, $3, $4::"AuditDeliveryStatus", now(), now())`,
      outboxId,
      tenantId,
      AUDIT_ACTION.ENTRY_CREATE,
      status,
    );
  }

  it("purges aged SENT and FAILED rows, keeping active, recent, and still-delivering rows", async () => {
    await runInRolledBackTx(async (tx) => {
      for (const statement of AMBIENT) await tx.$executeRawUnsafe(statement);

      const oldSentId = await insertSentAged(tx);
      // Aged SENT rows a delivery still needs: each NOT EXISTS keeps one.
      const auditPendingId = await insertSentAged(tx);
      await insertAuditDelivery(tx, auditPendingId, "PENDING");
      const auditProcessingId = await insertSentAged(tx);
      await insertAuditDelivery(tx, auditProcessingId, "PROCESSING");
      const webhookPendingId = await insertSentAged(tx);
      await insertWebhookDelivery(tx, webhookPendingId, "PENDING");
      const webhookProcessingId = await insertSentAged(tx);
      await insertWebhookDelivery(tx, webhookProcessingId, "PROCESSING");

      const oldFailedId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8,
                 now() - make_interval(days => $4) - interval '1 day', now())`,
        oldFailedId,
        tenantId,
        makePayload(),
        AUDIT_OUTBOX.FAILED_RETENTION_DAYS,
      );
      const recentFailedId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8, now() - interval '1 day', now())`,
        recentFailedId,
        tenantId,
        makePayload(),
      );
      const pendingId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', 0, 8, now() - interval '365 days', now())`,
        pendingId,
        tenantId,
        makePayload(),
      );
      const processingId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, processing_started_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 1, 8, now() - interval '365 days', now(), now())`,
        processingId,
        tenantId,
        makePayload(),
      );

      expect(await purgeSentAgedInTx(tx)).toBe(1);
      expect(await purgeFailedAgedInTx(tx)).toBe(1);

      const remaining = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id::text AS id FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      expect(remaining.map((r) => r.id).sort()).toEqual(
        [auditPendingId, auditProcessingId, webhookPendingId, webhookProcessingId, recentFailedId, pendingId, processingId].sort(),
      );
      expect(remaining.map((r) => r.id)).not.toContain(oldSentId);
      expect(remaining.map((r) => r.id)).not.toContain(oldFailedId);
    });
  });
});
