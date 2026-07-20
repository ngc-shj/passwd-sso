/**
 * C8: cap regression tests for C1 (reapStuckRows), C2 (reapStuckDeliveries),
 * and C3 (purgeRetention) — each must transition/purge EXACTLY `limit` rows on
 * one call, drain the remainder on a subsequent call, and (purgeRetention only)
 * never let a starved FAILED-aged budget be crowded out by SENT-aged rows
 * (S1 — the two-branch split gives FAILED its own cap).
 *
 * Determinism vs. the live worker: this suite runs against the shared dev DB,
 * which a live audit-outbox-worker (30s reaper, REAP_BATCH_SIZE=1000) sweeps
 * globally with no tenant/test-only marker. Asserting on the observed state of
 * the test's own rows after a call is therefore racy — the worker can reap all
 * of them at once. Asserting only `reaped <= limit` on the return value is
 * deterministic but a false negative: if the worker reaps my rows first, my
 * call returns 0 and `0 <= limit` passes even with a broken `LIMIT`.
 *
 * The fix: create the test's `limit + 1` eligible rows INSIDE a holding
 * transaction that ALWAYS rolls back (runInRolledBackTx), and run the real
 * sweep SQL (the exported `*InTx` seams) in that SAME transaction. Uncommitted
 * rows are invisible to every other transaction (MVCC), so the live worker
 * cannot see or reap them — the test is the sole sweeper of its own rows. The
 * `LIMIT` is then the ONLY thing bounding the count, so we can assert it
 * EXACTLY: one call returns `limit`, the next returns the remaining `1`. A
 * removed `LIMIT` would return `limit + 1` and fail — no false negative.
 * The rollback also guarantees zero side effects: the production sweep is
 * global (not tenant-scoped, by design), so if it happens to catch another
 * tenant's committed row, the rollback undoes that write.
 *
 * The S1 orchestration guard (FAILED branch runs even when the SENT branch
 * saturates its cap) is a different concern — proven at the orchestrator level
 * in the worker unit test, not here (this file exercises the branch helpers
 * directly, so it proves per-branch cap independence, not their sequencing).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import {
  reapStuckRowsInTx,
  reapStuckDeliveriesInTx,
  purgeSentAgedInTx,
  purgeFailedAgedInTx,
} from "@/workers/audit-outbox-worker";

type PrismaTx = Prisma.TransactionClient;

describe("audit-outbox sweep caps (C8)", () => {
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

  const makePayload = () =>
    JSON.stringify({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: randomUUID(),
      actorType: ACTOR_TYPE.HUMAN,
    });

  // Run `body` inside a holding transaction that ALWAYS rolls back. Two
  // guarantees this buys the cap assertions:
  //   1. Rows created in `body` are never committed, so they are invisible
  //      (MVCC) to the live audit-outbox-worker — the test is the sole sweeper
  //      of its own rows and the `LIMIT` cap is the only thing bounding the
  //      count, so it can be asserted exactly (2 → 1 → 0).
  //   2. The production sweep is a GLOBAL sweep (no tenant scoping, by design).
  //      If any other tenant's committed eligible rows happen to be caught by
  //      the sweep here, the rollback undoes those writes — the test has zero
  //      side effects on shared data. (Such rows can still consume the `LIMIT`
  //      on a shared dev DB, which would make an assertion FAIL loudly, never
  //      pass a broken cap; CI runs against a fresh DB with no other rows.)
  // A vitest assertion failure inside `body` propagates out (the tx still
  // rolls back), so failures are reported normally.
  const ROLLBACK = Symbol("rollback");
  async function runInRolledBackTx(
    body: (tx: PrismaTx) => Promise<void>,
  ): Promise<void> {
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

  // ─── reapStuckRows ──────────────────────────────────────────────

  describe("reapStuckRows", () => {
    // The cap is proven exactly: 3 eligible rows, LIMIT 2 → first call reaps
    // exactly 2, second reaps the remaining 1. The 3 rows are created inside a
    // rolled-back holding transaction (see runInRolledBackTx), so they are
    // invisible (MVCC) to the live worker — the test is the sole reaper of its
    // own rows. A removed production `LIMIT` would make the first call reap all
    // 3 and fail `toBe(2)`.
    it("reaps exactly `limit` of 3 eligible rows per call, draining the remainder next call", async () => {
      const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;

      await runInRolledBackTx(async (txH) => {
        for (let i = 0; i < 3; i++) {
          await txH.$executeRawUnsafe(
            `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
             VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 8,
                     now() - make_interval(secs => $4::double precision) - interval '60 seconds',
                     now(), now())`,
            randomUUID(),
            tenantId,
            makePayload(),
            timeoutSeconds,
          );
        }

        // First call: exactly `limit` (2) of the 3 eligible rows. Broken LIMIT ⇒ 3.
        expect(await reapStuckRowsInTx(txH, 2)).toBe(2);
        // Second call: drains the last 1.
        expect(await reapStuckRowsInTx(txH, 2)).toBe(1);
        // Nothing left eligible in this fenced set.
        expect(await reapStuckRowsInTx(txH, 2)).toBe(0);
      });
    });
  });

  // ─── reapStuckDeliveries ────────────────────────────────────────

  describe("reapStuckDeliveries", () => {
    // Same fenced-holding-transaction design as reapStuckRows: the target,
    // outbox parents, and 3 stuck deliveries are all created inside `txH` and
    // never committed, so the live worker cannot see or reap them. The cap is
    // asserted exactly against the delivery reaper's own `LIMIT`.
    it("reaps exactly `limit` of 3 eligible deliveries per call, draining the remainder next call", async () => {
      const processingStartedAt = new Date(Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS - 60_000);

      await runInRolledBackTx(async (txH) => {
        const targetId = randomUUID();
        await txH.$executeRawUnsafe(
          `INSERT INTO audit_delivery_targets (
            id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
            master_key_version, is_active, created_at
          ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK'::"AuditDeliveryTargetKind", 'test_enc', 'test_iv', 'test_tag', 1, true, now())`,
          targetId,
          tenantId,
        );

        for (let i = 0; i < 3; i++) {
          const outboxId = randomUUID();
          await txH.$executeRawUnsafe(
            `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
             VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', now())`,
            outboxId,
            tenantId,
            JSON.stringify({ scope: "PERSONAL", action: "ENTRY_CREATE", userId, actorType: "HUMAN" }),
          );
          await txH.$executeRawUnsafe(
            `INSERT INTO audit_deliveries (
              id, outbox_id, target_id, tenant_id, status,
              attempt_count, max_attempts, processing_started_at
            ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PROCESSING', 0, 8, $5::timestamptz)`,
            randomUUID(),
            outboxId,
            targetId,
            tenantId,
            processingStartedAt.toISOString(),
          );
        }

        // First call: exactly `limit` (2) of the 3 eligible deliveries. Broken LIMIT ⇒ 3.
        expect(await reapStuckDeliveriesInTx(txH, 2)).toBe(2);
        // Second call: drains the last 1.
        expect(await reapStuckDeliveriesInTx(txH, 2)).toBe(1);
        expect(await reapStuckDeliveriesInTx(txH, 2)).toBe(0);
      });
    });
  });

  // ─── purgeRetention ─────────────────────────────────────────────

  describe("purgeRetention", () => {
    async function insertSentAgedRow(tx: PrismaTx): Promise<void> {
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, sent_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', 1, 8, now() - interval '48 hours', now(),
                 now() - make_interval(hours => $4) - interval '1 hour')`,
        randomUUID(),
        tenantId,
        makePayload(),
        AUDIT_OUTBOX.RETENTION_HOURS,
      );
    }

    async function insertFailedAgedRow(tx: PrismaTx): Promise<void> {
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8,
                 now() - make_interval(days => $4) - interval '1 day', now())`,
        randomUUID(),
        tenantId,
        makePayload(),
        AUDIT_OUTBOX.FAILED_RETENTION_DAYS,
      );
    }

    // Same fenced-holding-transaction design: SENT-aged rows are created inside
    // `txH` and never committed, so the live worker cannot purge them. The
    // SENT branch's own `LIMIT` is asserted exactly.
    it("purges exactly `limit` of 3 SENT-aged rows per call, draining the remainder next call", async () => {
      await runInRolledBackTx(async (txH) => {
        for (let i = 0; i < 3; i++) await insertSentAgedRow(txH);

        // First call: exactly `limit` (2) of the 3 SENT-aged rows. Broken LIMIT ⇒ 3.
        expect(await purgeSentAgedInTx(txH, 2)).toBe(2);
        // Second call: drains the last 1.
        expect(await purgeSentAgedInTx(txH, 2)).toBe(1);
        expect(await purgeSentAgedInTx(txH, 2)).toBe(0);
      });
    });

    // S1 per-branch cap independence: with 3 SENT-aged rows (> limit=2) the
    // SENT branch purges exactly `limit` and leaves a backlog, yet the FAILED
    // branch still purges its own aged row — the two branches carry independent
    // caps, so a SENT backlog can never starve FAILED of its budget. (That the
    // orchestrator *runs* the FAILED branch even after the SENT branch
    // saturates is covered in the worker unit test — see "purgeRetention runs
    // the FAILED branch even when the SENT branch saturates its cap".)
    it("S1: the FAILED-aged branch purges its own row despite a SENT backlog exceeding the cap", async () => {
      await runInRolledBackTx(async (txH) => {
        for (let i = 0; i < 3; i++) await insertSentAgedRow(txH);
        await insertFailedAgedRow(txH);

        // SENT branch is capped at `limit` even with a backlog (leaves 1).
        expect(await purgeSentAgedInTx(txH, 2)).toBe(2);
        // FAILED branch has its own budget: its 1 aged row is purged, not starved.
        expect(await purgeFailedAgedInTx(txH, 2)).toBe(1);
        // Drain the remaining SENT-aged row.
        expect(await purgeSentAgedInTx(txH, 2)).toBe(1);
        expect(await purgeSentAgedInTx(txH, 2)).toBe(0);
      });
    });
  });
});
