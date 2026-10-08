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
 *
 * Later suites (worker-batch-limit-overrun plan, C3): forced-plan caps for the
 * locking members M1–M6 with tied ORDER BY values, exact caps for the
 * delivery-retention purges M7/M8, and the seam guard — every exported *InTx
 * seam refuses a transaction without the audit_write bypass before writing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/constants/time";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  claimOutboxBatchInTx,
  claimDeliveriesInTx,
  claimWebhookDeliveriesInTx,
  reapStuckRowsInTx,
  reapStuckDeliveriesInTx,
  reapStuckWebhookDeliveriesInTx,
  purgeDeliveryRetentionInTx,
  purgeWebhookDeliveryRetentionInTx,
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
  // `setGucs` defaults to the audit-write bypass the production wrappers set;
  // the guard tests pass a weaker setter to prove the seams refuse to run.
  const ROLLBACK = Symbol("rollback");
  async function runInRolledBackTx(
    body: (tx: PrismaTx) => Promise<void>,
    setGucs: (tx: PrismaTx) => Promise<void> = setBypassRlsGucs,
  ): Promise<void> {
    try {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setGucs(tx);
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

  // ─── Shared fixtures for the forced-plan and guard suites ──────────

  const sentCutoff = () => new Date(Date.now() - AUDIT_OUTBOX.RETENTION_HOURS * MS_PER_HOUR);
  const failedCutoff = () =>
    new Date(Date.now() - AUDIT_OUTBOX.FAILED_RETENTION_DAYS * MS_PER_DAY);

  async function insertTarget(tx: PrismaTx): Promise<string> {
    const targetId = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO audit_delivery_targets (
        id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
        master_key_version, is_active, created_at
      ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK'::"AuditDeliveryTargetKind", 'test_enc', 'test_iv', 'test_tag', 1, true, now())`,
      targetId,
      tenantId,
    );
    return targetId;
  }

  // Each inserter writes `count` rows in ONE statement with the member's
  // ORDER BY column bound once (`orderValue`), so every row ties on it and the
  // btree returns them in heap order — the order the outer scan also visits.
  // Returns the inserted ids.
  type TiedInserter = (tx: PrismaTx, count: number, orderValue: Date) => Promise<string[]>;

  const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);

  const insertPendingOutbox: TiedInserter = async (tx, count, orderValue) =>
    idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status, created_at, next_retry_at)
       SELECT gen_random_uuid(), $1::uuid, $2::jsonb, 'PENDING', $3::timestamptz, $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      tenantId, makePayload(), orderValue.toISOString(), count,
    ));

  const insertPendingDeliveries: TiedInserter = async (tx, count, orderValue) => {
    const targetId = await insertTarget(tx);
    return idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status, next_retry_at, created_at)
       SELECT gen_random_uuid(), gen_random_uuid(), $1::uuid, $2::uuid, 'PENDING', $3::timestamptz, $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      targetId, tenantId, orderValue.toISOString(), count,
    ));
  };

  const insertPendingWebhookDeliveries: TiedInserter = async (tx, count, orderValue) =>
    idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO webhook_deliveries (id, outbox_id, tenant_id, scope, team_id, action, status, next_retry_at, created_at)
       SELECT gen_random_uuid(), gen_random_uuid(), $1::uuid, 'TENANT', NULL, $2, 'PENDING', $3::timestamptz, $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      tenantId, AUDIT_ACTION.ENTRY_CREATE, orderValue.toISOString(), count,
    ));

  const insertStuckOutbox: TiedInserter = async (tx, count, orderValue) =>
    idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
       SELECT gen_random_uuid(), $1::uuid, $2::jsonb, 'PROCESSING', 0, 8, $3::timestamptz, now(), now()
       FROM generate_series(1, $4::int)
       RETURNING id`,
      tenantId, makePayload(), orderValue.toISOString(), count,
    ));

  const insertStuckDeliveries: TiedInserter = async (tx, count, orderValue) => {
    const targetId = await insertTarget(tx);
    return idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status, attempt_count, max_attempts, processing_started_at)
       SELECT gen_random_uuid(), gen_random_uuid(), $1::uuid, $2::uuid, 'PROCESSING', 0, 8, $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      targetId, tenantId, orderValue.toISOString(), count,
    ));
  };

  const insertStuckWebhookDeliveries: TiedInserter = async (tx, count, orderValue) =>
    idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO webhook_deliveries (id, outbox_id, tenant_id, scope, team_id, action, status, attempt_count, max_attempts, processing_started_at)
       SELECT gen_random_uuid(), gen_random_uuid(), $1::uuid, 'TENANT', NULL, $2, 'PROCESSING', 0, 8, $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      tenantId, AUDIT_ACTION.ENTRY_CREATE, orderValue.toISOString(), count,
    ));

  const insertSentAgedDeliveries: TiedInserter = async (tx, count, orderValue) => {
    const targetId = await insertTarget(tx);
    return idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status, created_at)
       SELECT gen_random_uuid(), gen_random_uuid(), $1::uuid, $2::uuid, 'SENT', $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      targetId, tenantId, orderValue.toISOString(), count,
    ));
  };

  const insertSentAgedWebhookDeliveries: TiedInserter = async (tx, count, orderValue) =>
    idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO webhook_deliveries (id, outbox_id, tenant_id, scope, team_id, action, status, created_at)
       SELECT gen_random_uuid(), gen_random_uuid(), $1::uuid, 'TENANT', NULL, $2, 'SENT', $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      tenantId, AUDIT_ACTION.ENTRY_CREATE, orderValue.toISOString(), count,
    ));

  const insertSentAgedOutbox: TiedInserter = async (tx, count, orderValue) =>
    idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, sent_at)
       SELECT gen_random_uuid(), $1::uuid, $2::jsonb, 'SENT', 1, 8, $3::timestamptz, $3::timestamptz, $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      tenantId, makePayload(), orderValue.toISOString(), count,
    ));

  const insertFailedAgedOutbox: TiedInserter = async (tx, count, orderValue) =>
    idsOf(await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
       SELECT gen_random_uuid(), $1::uuid, $2::jsonb, 'FAILED', 8, 8, $3::timestamptz, $3::timestamptz
       FROM generate_series(1, $4::int)
       RETURNING id`,
      tenantId, makePayload(), orderValue.toISOString(), count,
    ));

  // ─── Forced-plan caps (M1–M6) ───────────────────────────────────

  // GUCs that push a `LIMIT … FOR UPDATE` IN-subquery onto the inner side of a
  // Nested Loop Semi Join, where it is rescanned once per outer row. Each
  // rescan's LockRows skips rows this statement already updated, so a
  // subquery-shaped bound admits more than `limit` (see the plan's probe).
  const RESCAN_PLAN_GUCS = [
    "enable_hashagg",
    "enable_hashjoin",
    "enable_mergejoin",
    "enable_material",
    "enable_sort",
  ] as const;

  async function forceRescanPlan(tx: PrismaTx): Promise<void> {
    for (const guc of RESCAN_PLAN_GUCS) {
      await tx.$executeRawUnsafe(`SET LOCAL ${guc} = off`);
      const [row] = await tx.$queryRawUnsafe<Record<string, string>[]>(`SHOW ${guc}`);
      expect(row[guc]).toBe("off");
    }
  }

  interface ForcedPlanMember {
    name: string;
    // Moves every ambient eligible row out of the member's predicate by
    // updating its eligibility column only — no delete, no status change —
    // through the holding tx, so the rollback restores it.
    neutralise: string;
    countEligible: string;
    insertTied: TiedInserter;
    tiedValue: () => Date;
    run: (tx: PrismaTx, limit: number) => Promise<number>;
  }

  const stuckSince = () => new Date(Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS - 60_000);
  const dueSince = () => new Date(Date.now() - 60_000);

  // M1–M4 overran against the pre-fix SQL under these settings, so their rows
  // fail if the materialized key set is undone. M5 and M6 did not: with no
  // index on processing_started_at, the planner unique-ifies their subquery on
  // the outer side and evaluates it once even under the forced settings (see
  // deviation D-1). Their rows are post-fix cap assertions only; a revert of
  // their key set is caught statically by check-limited-subquery-write.
  const FORCED_PLAN_MEMBERS: ForcedPlanMember[] = [
    {
      name: "M1 claimOutboxBatchInTx",
      neutralise: `UPDATE audit_outbox SET next_retry_at = 'infinity'
                   WHERE status = 'PENDING' AND next_retry_at <= now()`,
      countEligible: `SELECT count(*)::int AS n FROM audit_outbox
                      WHERE status = 'PENDING' AND next_retry_at <= now()`,
      insertTied: insertPendingOutbox,
      tiedValue: dueSince,
      run: async (tx, limit) => (await claimOutboxBatchInTx(tx, limit)).length,
    },
    {
      name: "M2 claimDeliveriesInTx",
      neutralise: `UPDATE audit_deliveries SET next_retry_at = 'infinity'
                   WHERE status = 'PENDING' AND next_retry_at <= now()`,
      countEligible: `SELECT count(*)::int AS n FROM audit_deliveries
                      WHERE status = 'PENDING' AND next_retry_at <= now()`,
      insertTied: insertPendingDeliveries,
      tiedValue: dueSince,
      run: async (tx, limit) => (await claimDeliveriesInTx(tx, limit)).length,
    },
    {
      name: "M3 claimWebhookDeliveriesInTx",
      neutralise: `UPDATE webhook_deliveries SET next_retry_at = 'infinity'
                   WHERE status = 'PENDING' AND next_retry_at <= now()`,
      countEligible: `SELECT count(*)::int AS n FROM webhook_deliveries
                      WHERE status = 'PENDING' AND next_retry_at <= now()`,
      insertTied: insertPendingWebhookDeliveries,
      tiedValue: dueSince,
      run: async (tx, limit) => (await claimWebhookDeliveriesInTx(tx, limit)).length,
    },
    {
      name: "M4 reapStuckRowsInTx",
      neutralise: `UPDATE audit_outbox SET processing_started_at = now()
                   WHERE status = 'PROCESSING' AND processing_started_at < now()`,
      countEligible: `SELECT count(*)::int AS n FROM audit_outbox
                      WHERE status = 'PROCESSING' AND processing_started_at < now()`,
      insertTied: insertStuckOutbox,
      tiedValue: stuckSince,
      run: (tx, limit) => reapStuckRowsInTx(tx, limit),
    },
    {
      name: "M5 reapStuckDeliveriesInTx",
      neutralise: `UPDATE audit_deliveries SET processing_started_at = now()
                   WHERE status = 'PROCESSING' AND processing_started_at < now()`,
      countEligible: `SELECT count(*)::int AS n FROM audit_deliveries
                      WHERE status = 'PROCESSING' AND processing_started_at < now()`,
      insertTied: insertStuckDeliveries,
      tiedValue: stuckSince,
      run: (tx, limit) => reapStuckDeliveriesInTx(tx, limit),
    },
    {
      name: "M6 reapStuckWebhookDeliveriesInTx",
      neutralise: `UPDATE webhook_deliveries SET processing_started_at = now()
                   WHERE status = 'PROCESSING' AND processing_started_at < now()`,
      countEligible: `SELECT count(*)::int AS n FROM webhook_deliveries
                      WHERE status = 'PROCESSING' AND processing_started_at < now()`,
      insertTied: insertStuckWebhookDeliveries,
      tiedValue: stuckSince,
      run: (tx, limit) => reapStuckWebhookDeliveriesInTx(tx, limit),
    },
  ];

  describe("forced rescan plan: a locking bound touches at most `limit` rows", () => {
    const LIMIT = 2;

    async function isolate(tx: PrismaTx, member: ForcedPlanMember): Promise<void> {
      await tx.$executeRawUnsafe(member.neutralise);
      const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(member.countEligible);
      expect(n).toBe(0);
    }

    // The members are global sweeps, so ambient eligible rows are first made
    // ineligible inside the holding tx. A row a live dev server commits after
    // that check can still interfere; CI has none.
    it.each(FORCED_PLAN_MEMBERS)("$name: limit + 1 tied rows → limit, remainder, 0", async (member) => {
      await runInRolledBackTx(async (txH) => {
        await isolate(txH, member);
        await member.insertTied(txH, LIMIT + 1, member.tiedValue());
        await forceRescanPlan(txH);

        expect(await member.run(txH, LIMIT)).toBe(LIMIT);
        expect(await member.run(txH, LIMIT)).toBe(1);
        expect(await member.run(txH, LIMIT)).toBe(0);
      });
    });

    it.each(FORCED_PLAN_MEMBERS)("$name: exactly limit tied rows → all of them", async (member) => {
      await runInRolledBackTx(async (txH) => {
        await isolate(txH, member);
        await member.insertTied(txH, LIMIT, member.tiedValue());
        await forceRescanPlan(txH);

        expect(await member.run(txH, LIMIT)).toBe(LIMIT);
        expect(await member.run(txH, LIMIT)).toBe(0);
      });
    });
  });

  // ─── Retention purge of delivery rows (M7, M8) ──────────────────

  describe("delivery retention purge caps", () => {
    // Lock-free deletes, so no forced plan. Like the outbox purge tests above,
    // aged terminal rows already on a shared dev DB make the remainder steps
    // fail loudly; they cannot pass a broken cap, and CI starts empty.
    const agedSent = () => new Date(sentCutoff().getTime() - MS_PER_HOUR);

    it("M7 purgeDeliveryRetentionInTx: exactly `limit` of 3 SENT-aged deliveries per call", async () => {
      await runInRolledBackTx(async (txH) => {
        await insertSentAgedDeliveries(txH, 3, agedSent());

        expect(await purgeDeliveryRetentionInTx(txH, sentCutoff(), failedCutoff(), 2)).toBe(2);
        expect(await purgeDeliveryRetentionInTx(txH, sentCutoff(), failedCutoff(), 2)).toBe(1);
        expect(await purgeDeliveryRetentionInTx(txH, sentCutoff(), failedCutoff(), 2)).toBe(0);
      });
    });

    it("M8 purgeWebhookDeliveryRetentionInTx: exactly `limit` of 3 SENT-aged webhook deliveries per call", async () => {
      await runInRolledBackTx(async (txH) => {
        await insertSentAgedWebhookDeliveries(txH, 3, agedSent());

        expect(await purgeWebhookDeliveryRetentionInTx(txH, sentCutoff(), failedCutoff(), 2)).toBe(2);
        expect(await purgeWebhookDeliveryRetentionInTx(txH, sentCutoff(), failedCutoff(), 2)).toBe(1);
        expect(await purgeWebhookDeliveryRetentionInTx(txH, sentCutoff(), failedCutoff(), 2)).toBe(0);
      });
    });
  });

  // ─── Seam guard: no audit-write bypass, no write ────────────────

  describe("seams refuse a transaction without the audit-write bypass", () => {
    // Ancient ORDER BY values put the fixtures first in every member's order,
    // so a seam that wrote before asserting would change them even on a busy
    // dev DB, and the unchanged-rows check below would fail.
    const ANCIENT = new Date("2000-01-01T00:00:00Z");
    const GUARD_LIMIT = 10;

    interface GuardedSeam {
      name: string;
      table: "audit_outbox" | "audit_deliveries" | "webhook_deliveries";
      insert: TiedInserter;
      run: (tx: PrismaTx) => Promise<unknown>;
    }

    const SEAMS: GuardedSeam[] = [
      { name: "claimOutboxBatchInTx", table: "audit_outbox", insert: insertPendingOutbox,
        run: (tx) => claimOutboxBatchInTx(tx, GUARD_LIMIT) },
      { name: "claimDeliveriesInTx", table: "audit_deliveries", insert: insertPendingDeliveries,
        run: (tx) => claimDeliveriesInTx(tx, GUARD_LIMIT) },
      { name: "claimWebhookDeliveriesInTx", table: "webhook_deliveries", insert: insertPendingWebhookDeliveries,
        run: (tx) => claimWebhookDeliveriesInTx(tx, GUARD_LIMIT) },
      { name: "reapStuckRowsInTx", table: "audit_outbox", insert: insertStuckOutbox,
        run: (tx) => reapStuckRowsInTx(tx, GUARD_LIMIT) },
      { name: "reapStuckDeliveriesInTx", table: "audit_deliveries", insert: insertStuckDeliveries,
        run: (tx) => reapStuckDeliveriesInTx(tx, GUARD_LIMIT) },
      { name: "reapStuckWebhookDeliveriesInTx", table: "webhook_deliveries", insert: insertStuckWebhookDeliveries,
        run: (tx) => reapStuckWebhookDeliveriesInTx(tx, GUARD_LIMIT) },
      { name: "purgeDeliveryRetentionInTx", table: "audit_deliveries", insert: insertSentAgedDeliveries,
        run: (tx) => purgeDeliveryRetentionInTx(tx, sentCutoff(), failedCutoff(), GUARD_LIMIT) },
      { name: "purgeWebhookDeliveryRetentionInTx", table: "webhook_deliveries", insert: insertSentAgedWebhookDeliveries,
        run: (tx) => purgeWebhookDeliveryRetentionInTx(tx, sentCutoff(), failedCutoff(), GUARD_LIMIT) },
      { name: "purgeSentAgedInTx", table: "audit_outbox", insert: insertSentAgedOutbox,
        run: (tx) => purgeSentAgedInTx(tx, GUARD_LIMIT) },
      { name: "purgeFailedAgedInTx", table: "audit_outbox", insert: insertFailedAgedOutbox,
        run: (tx) => purgeFailedAgedInTx(tx, GUARD_LIMIT) },
    ];

    const GUC_SETTERS: { label: string; set: (tx: PrismaTx) => Promise<void> }[] = [
      { label: "no bypass GUCs", set: async () => {} },
      {
        label: "a different bypass purpose",
        set: async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
          await tx.$executeRaw`SELECT set_config('app.bypass_purpose', ${BYPASS_PURPOSE.SYSTEM_MAINTENANCE}, true)`;
        },
      },
    ];

    async function snapshot(tx: PrismaTx, table: GuardedSeam["table"], ids: string[]): Promise<unknown[]> {
      const select = {
        audit_outbox: `SELECT id, status::text AS status, attempt_count, processing_started_at FROM audit_outbox WHERE id = ANY($1::uuid[]) ORDER BY id`,
        audit_deliveries: `SELECT id, status::text AS status, attempt_count, processing_started_at FROM audit_deliveries WHERE id = ANY($1::uuid[]) ORDER BY id`,
        webhook_deliveries: `SELECT id, status::text AS status, attempt_count, processing_started_at FROM webhook_deliveries WHERE id = ANY($1::uuid[]) ORDER BY id`,
      }[table];
      return tx.$queryRawUnsafe(select, ids);
    }

    const CASES = SEAMS.flatMap((seam) => GUC_SETTERS.map((gucs) => ({ ...seam, gucs })));

    it.each(CASES)("$name with $gucs.label throws and leaves its eligible rows unchanged", async (seam) => {
      await runInRolledBackTx(async (txH) => {
        const ids = await seam.insert(txH, 2, ANCIENT);
        const before = await snapshot(txH, seam.table, ids);
        expect(before).toHaveLength(2);

        // Caught inside the holding tx: the guard is a read plus a JS throw,
        // so the transaction is still usable for the re-read.
        await expect(seam.run(txH)).rejects.toThrow(/audit_write RLS bypass/);

        expect(await snapshot(txH, seam.table, ids)).toEqual(before);
      }, seam.gucs.set);
    });
  });
});
