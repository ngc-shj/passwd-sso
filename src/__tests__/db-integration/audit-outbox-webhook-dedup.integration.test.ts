/**
 * Finding 2 regression: a conflicting re-delivery (deliverRowWithChain returns
 * delivered:true, inserted:false) marks the outbox row SENT but must NOT
 * dispatch webhook / fan-out a second time. processBatch gates
 * dispatchWebhookForRow + fanOutDeliveries on `inserted` via the production
 * `if (!didInsert) continue` guard (audit-outbox-worker.ts:1181).
 *
 * dispatchWebhookForRow and fanOutDeliveries are fire-and-forget side effects
 * driven by the PRIVATE processBatch, so the honest way to exercise the
 * production gate is to run the real worker loop (createWorker().start()) for
 * one tick — NOT to re-implement the gate in the test. The DB-observable proxy
 * for fan-out is fanOutDeliveries, which inserts audit_deliveries rows for
 * active non-DB targets. We assert fan-out fires once per row, not once per
 * delivery attempt:
 *
 *   - conflicting row: an audit_logs row for its outbox_id is pre-inserted so
 *     the worker's INSERT ... ON CONFLICT (outbox_id) DO NOTHING loses
 *     (inserted:false) → gate skips fan-out → ZERO audit_deliveries rows.
 *   - control row (non-vacuous guard): a fresh row with no conflict delivers
 *     for the first time (inserted:true) → fan-out runs → audit_deliveries rows
 *     ARE created. Without this control, the zero-count on the conflicting row
 *     could be a false pass (e.g. if fan-out were broken for all rows).
 *
 * Both rows are processed in the SAME real worker tick, so the only difference
 * between them is the `inserted` discriminator the production gate keys on.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
  type PrismaWithPool,
} from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { createWorker } from "@/workers/audit-outbox-worker";

// worker-role connection string, reused for createWorker (matches how the
// concurrent-delivery test constructs worker-role clients).
function workerDatabaseUrl(): string {
  const base = process.env.DATABASE_URL!;
  return (
    process.env.OUTBOX_WORKER_DATABASE_URL ??
    base.replace(/\/\/[^:]+:[^@]+@/, "//passwd_outbox_worker:passwd_outbox_pass@")
  );
}

describe("audit-outbox webhook/fan-out dedup on conflicting re-delivery (Finding 2)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let su: PrismaWithPool;

  beforeAll(async () => {
    ctx = await createTestContext();
    su = ctx.su;
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    // Fan-out gating on `inserted` only matters on the chain path; the non-chain
    // path hardcodes didInsert=true. Enable the chain so deliverRowWithChain's
    // ON CONFLICT discriminator drives the gate.
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantId,
      );
    });
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  function makePayload(): Record<string, unknown> {
    return {
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId,
      actorType: ACTOR_TYPE.HUMAN,
    };
  }

  async function insertPendingRow(): Promise<string> {
    const id = randomUUID();
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PENDING', 0, 8, now(), now())`,
        id,
        tenantId,
        JSON.stringify(makePayload()),
      );
    });
    return id;
  }

  async function insertActiveNonDbTarget(kind: string): Promise<string> {
    const id = randomUUID();
    await su.prisma.$transaction(async (tx) => {
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

  /**
   * Pre-insert an audit_logs row for `outboxId` so the worker's own
   * INSERT ... ON CONFLICT (outbox_id) DO NOTHING loses the race (inserted:false),
   * exactly as a prior winning delivery would leave it. This makes the row a
   * "conflicting re-delivery" when the worker later claims and delivers it.
   */
  async function preInsertConflictingAuditLog(outboxId: string): Promise<void> {
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, created_at, outbox_id
        ) VALUES (
          gen_random_uuid(), $1::uuid, $2::"AuditScope", $3::"AuditAction",
          $4::uuid, $5::"ActorType", now(), $6::uuid
        )`,
        tenantId,
        AUDIT_SCOPE.PERSONAL,
        AUDIT_ACTION.ENTRY_CREATE,
        userId,
        ACTOR_TYPE.HUMAN,
        outboxId,
      );
    });
  }

  async function getOutboxStatus(id: string): Promise<string | null> {
    const rows = await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status::text FROM audit_outbox WHERE id = $1::uuid`,
        id,
      );
    });
    return rows[0]?.status ?? null;
  }

  async function countDeliveriesFor(outboxId: string): Promise<number> {
    const rows = await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_deliveries WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
    return Number(rows[0]!.cnt);
  }

  /** Sleep helper (no fake timers — real worker loop uses real setTimeout). */
  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  it("fan-out fires once per row, not per delivery attempt: a conflicting re-delivery skips fan-out while a fresh delivery fans out (RT5)", async () => {
    await insertActiveNonDbTarget("WEBHOOK");

    // Conflicting row: a prior audit_logs row already owns its outbox_id, so the
    // worker's delivery will conflict (inserted:false) → gate must skip fan-out.
    const conflictingId = await insertPendingRow();
    await preInsertConflictingAuditLog(conflictingId);

    // Control row: no pre-existing conflict → first delivery wins
    // (inserted:true) → fan-out must run.
    const controlId = await insertPendingRow();

    // Drive the REAL worker loop so the production `if (!didInsert) continue`
    // gate is exercised. Short poll interval; stop as soon as both rows are SENT.
    const worker = createWorker({
      databaseUrl: workerDatabaseUrl(),
      batchSize: 10,
      pollIntervalMs: 50,
    });
    const startPromise = worker.start();

    // Poll until both rows have been processed (SENT) or a hard timeout.
    const deadline = Date.now() + 15_000;
    let bothSent = false;
    while (Date.now() < deadline) {
      const a = await getOutboxStatus(conflictingId);
      const b = await getOutboxStatus(controlId);
      if (a === "SENT" && b === "SENT") {
        bothSent = true;
        break;
      }
      await sleep(50);
    }

    worker.stop();
    await startPromise;

    expect(bothSent).toBe(true);

    // Give the fire-and-forget fanOutDeliveries a brief moment to settle after
    // the row was marked SENT (it runs .catch()-attached, not awaited).
    await sleep(200);

    // Control row delivered fresh (inserted:true) → fan-out ran → one delivery
    // row per active non-DB target (1 target here). This is the non-vacuous
    // guard: fan-out DID fire when it should, so the zero below is meaningful.
    expect(await countDeliveriesFor(controlId)).toBe(1);

    // Conflicting row was marked SENT but delivered:true/inserted:false → the
    // production gate skipped fan-out → NO audit_deliveries rows. Fan-out fires
    // once per row, never a second time on a conflicting re-delivery.
    expect(await countDeliveriesFor(conflictingId)).toBe(0);
  });
});
