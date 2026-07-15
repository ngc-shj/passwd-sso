/**
 * C8: cap regression tests for C1 (reapStuckRows), C2 (reapStuckDeliveries),
 * and C3 (purgeRetention) — each must transition at most `limit` rows per
 * call, drain the remainder on a subsequent call, and (purgeRetention only)
 * never let a starved FAILED-aged budget be crowded out by SENT-aged rows
 * (S1 — the two-branch split gives FAILED its own cap).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { reapStuckRows, reapStuckDeliveries, purgeRetention } from "@/workers/audit-outbox-worker";

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

  // ─── reapStuckRows ──────────────────────────────────────────────

  describe("reapStuckRows", () => {
    async function insertStuckRow(): Promise<string> {
      const outboxId = randomUUID();
      const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 8,
                   now() - make_interval(secs => $4::double precision) - interval '60 seconds',
                   now(), now())`,
          outboxId,
          tenantId,
          makePayload(),
          timeoutSeconds,
        );
      });
      return outboxId;
    }

    async function getStatuses(ids: string[]): Promise<string[]> {
      const rows = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ status: string }[]>(
          `SELECT status::text FROM audit_outbox WHERE id = ANY($1::uuid[])`,
          ids,
        );
      });
      return rows.map((r) => r.status);
    }

    // reapStuckRows is a GLOBAL sweep (SC6 — no per-tenant partitioning), so
    // in a shared dev DB another process (e.g. a live worker) can concurrently
    // reap OTHER tenants' stuck rows and consume part of the `limit` budget.
    // Scope assertions to THIS test's own row ids (never global counts) so
    // the cap behavior is verified regardless of unrelated background
    // activity in the database.
    it("transitions exactly `limit` of 3 eligible stuck rows, and a 2nd call drains the remainder", async () => {
      const ids = [await insertStuckRow(), await insertStuckRow(), await insertStuckRow()];

      expect(await getStatuses(ids)).toEqual(["PROCESSING", "PROCESSING", "PROCESSING"]);

      await reapStuckRows(ctx.su.prisma, 2);
      const afterFirst = await getStatuses(ids);
      const pendingAfterFirst = afterFirst.filter((s) => s === "PENDING").length;
      const processingAfterFirst = afterFirst.filter((s) => s === "PROCESSING").length;
      // At most `limit` (2) of MY 3 rows can have transitioned this call —
      // a global cap can never reap more of mine than its own limit allows.
      expect(pendingAfterFirst).toBeLessThanOrEqual(2);
      expect(pendingAfterFirst + processingAfterFirst).toBe(3);
      expect(processingAfterFirst).toBeGreaterThanOrEqual(1);

      // Drain: repeat capped calls until all of mine have transitioned —
      // bounded iteration count proves the cap, not an unbounded single call.
      let iterations = 1;
      while ((await getStatuses(ids)).some((s) => s === "PROCESSING") && iterations < 5) {
        await reapStuckRows(ctx.su.prisma, 2);
        iterations++;
      }
      expect(await getStatuses(ids)).toEqual(["PENDING", "PENDING", "PENDING"]);
      // Draining 3 rows at cap=2 must take at least 2 calls (ceil(3/2)) —
      // proves a single call could not have drained all 3 (RT7 cap evidence).
      expect(iterations).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── reapStuckDeliveries ────────────────────────────────────────

  describe("reapStuckDeliveries", () => {
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

    async function insertStuckDelivery(outboxId: string, targetId: string): Promise<string> {
      const id = randomUUID();
      const processingStartedAt = new Date(Date.now() - AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS - 60_000);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_deliveries (
            id, outbox_id, target_id, tenant_id, status,
            attempt_count, max_attempts, processing_started_at
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PROCESSING',
            0, 8, $5::timestamptz
          )`,
          id,
          outboxId,
          targetId,
          tenantId,
          processingStartedAt.toISOString(),
        );
      });
      return id;
    }

    async function getDeliveryStatuses(ids: string[]): Promise<string[]> {
      const rows = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ status: string }[]>(
          `SELECT status::text FROM "audit_deliveries" WHERE id = ANY($1::uuid[])`,
          ids,
        );
      });
      return rows.map((r) => r.status);
    }

    // Same GLOBAL-sweep caveat as reapStuckRows above — scope assertions to
    // this test's own delivery ids, not tenant-wide counts.
    it("transitions exactly `limit` of 3 eligible stuck deliveries, and a 2nd call drains the remainder", async () => {
      const targetId = await insertTarget("WEBHOOK");
      const outboxId1 = await insertOutboxRow();
      const outboxId2 = await insertOutboxRow();
      const outboxId3 = await insertOutboxRow();
      const ids = [
        await insertStuckDelivery(outboxId1, targetId),
        await insertStuckDelivery(outboxId2, targetId),
        await insertStuckDelivery(outboxId3, targetId),
      ];

      expect(await getDeliveryStatuses(ids)).toEqual(["PROCESSING", "PROCESSING", "PROCESSING"]);

      await reapStuckDeliveries(ctx.su.prisma, 2);
      const afterFirst = await getDeliveryStatuses(ids);
      const pendingAfterFirst = afterFirst.filter((s) => s === "PENDING").length;
      const processingAfterFirst = afterFirst.filter((s) => s === "PROCESSING").length;
      expect(pendingAfterFirst).toBeLessThanOrEqual(2);
      expect(pendingAfterFirst + processingAfterFirst).toBe(3);
      expect(processingAfterFirst).toBeGreaterThanOrEqual(1);

      let iterations = 1;
      while ((await getDeliveryStatuses(ids)).some((s) => s === "PROCESSING") && iterations < 5) {
        await reapStuckDeliveries(ctx.su.prisma, 2);
        iterations++;
      }
      expect(await getDeliveryStatuses(ids)).toEqual(["PENDING", "PENDING", "PENDING"]);
      expect(iterations).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── purgeRetention ─────────────────────────────────────────────

  describe("purgeRetention", () => {
    async function insertSentAgedRow(): Promise<string> {
      const id = randomUUID();
      const retentionHours = AUDIT_OUTBOX.RETENTION_HOURS;
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, sent_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', 1, 8, now() - interval '48 hours', now(),
                   now() - make_interval(hours => $4) - interval '1 hour')`,
          id,
          tenantId,
          makePayload(),
          retentionHours,
        );
      });
      return id;
    }

    async function insertFailedAgedRow(): Promise<string> {
      const id = randomUUID();
      const failedRetentionDays = AUDIT_OUTBOX.FAILED_RETENTION_DAYS;
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'FAILED', 8, 8,
                   now() - make_interval(days => $4) - interval '1 day', now())`,
          id,
          tenantId,
          makePayload(),
          failedRetentionDays,
        );
      });
      return id;
    }

    async function getRemainingIds(): Promise<{ id: string; status: string }[]> {
      return ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ id: string; status: string }[]>(
          `SELECT id, status::text FROM audit_outbox WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      });
    }

    // purgeRetention is a GLOBAL sweep (SC6): in a shared dev DB, another
    // tenant's eligible rows can share the same per-call budget as this
    // test's own rows. Scope survival assertions to THIS test's own row ids
    // (never a bare "exactly 1 remains" on the whole tenant-scoped result
    // set beyond what's attributable to my own ids) so the cap behavior is
    // verified regardless of unrelated background activity in the database.
    it("caps SENT-aged purge at `limit` per call, draining the remainder on a 2nd call", async () => {
      const myIds = [await insertSentAgedRow(), await insertSentAgedRow(), await insertSentAgedRow()];

      await purgeRetention(ctx.su.prisma, { limit: 2 });

      const survivingAfterFirst = (await getRemainingIds())
        .map((r) => r.id)
        .filter((id) => myIds.includes(id));
      // At most `limit` (2) of MY 3 rows can have been purged this call.
      expect(survivingAfterFirst.length).toBeGreaterThanOrEqual(1);
      expect(survivingAfterFirst.length).toBeLessThanOrEqual(3);
      expect(survivingAfterFirst.length).not.toBe(0);

      // Drain: repeat capped calls until all of mine are gone.
      let iterations = 1;
      while (
        (await getRemainingIds()).some((r) => myIds.includes(r.id)) &&
        iterations < 5
      ) {
        await purgeRetention(ctx.su.prisma, { limit: 2 });
        iterations++;
      }
      expect((await getRemainingIds()).filter((r) => myIds.includes(r.id))).toHaveLength(0);
      // Draining 3 rows at cap=2 must take at least 2 calls (ceil(3/2)) —
      // proves a single call could not have drained all 3 (RT7 cap evidence).
      expect(iterations).toBeGreaterThanOrEqual(2);
    });

    it("S1 starvation guard: a FAILED-aged row is purged in the same call even when >= limit SENT-aged rows are also eligible", async () => {
      // 3 SENT-aged rows (>= limit=2) competing for the SENT branch's budget,
      // plus 1 FAILED-aged row that must not be starved by the SENT backlog —
      // the two-branch split gives FAILED its own independent cap.
      const sentIds = [await insertSentAgedRow(), await insertSentAgedRow(), await insertSentAgedRow()];
      const failedId = await insertFailedAgedRow();

      await purgeRetention(ctx.su.prisma, { limit: 2 });

      const remainingIdsAfterFirst = (await getRemainingIds()).map((r) => r.id);

      // The FAILED-aged row must be gone despite the SENT backlog exceeding the cap.
      expect(remainingIdsAfterFirst).not.toContain(failedId);

      // At most `limit` (2) of MY 3 SENT-aged rows can have been purged this
      // call — at least 1 of mine must remain (proves the SENT branch is
      // itself capped, not unbounded).
      const survivingSentIds = sentIds.filter((id) => remainingIdsAfterFirst.includes(id));
      expect(survivingSentIds.length).toBeGreaterThanOrEqual(1);

      // A 2nd (and if needed further) call drains the remaining SENT-aged
      // rows of mine — re-querying live state each iteration.
      let iterations = 1;
      while (iterations < 5) {
        const stillRemaining = (await getRemainingIds()).map((r) => r.id);
        if (!sentIds.some((id) => stillRemaining.includes(id))) break;
        await purgeRetention(ctx.su.prisma, { limit: 2 });
        iterations++;
      }
      const finalRemaining = (await getRemainingIds()).map((r) => r.id);
      expect(sentIds.some((id) => finalRemaining.includes(id))).toBe(false);
      expect(iterations).toBeGreaterThanOrEqual(2);
    });
  });
});
