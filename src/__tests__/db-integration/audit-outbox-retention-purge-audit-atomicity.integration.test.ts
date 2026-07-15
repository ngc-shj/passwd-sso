/**
 * Finding 1 regression: purgeRetention emits AUDIT_OUTBOX_RETENTION_PURGED
 * INSIDE each branch's DELETE transaction (SENT branch tx and FAILED branch tx
 * independently), via the private writeDirectAuditLogInTx. So per tick there
 * can be up to TWO RETENTION_PURGED audit_logs rows (one per branch that purged
 * > 0), each with metadata.purgedCount = that branch's count, each committed
 * atomically with its branch's DELETE.
 *
 * The load-bearing assertion is atomicity under partial failure: a destructive
 * DELETE must never commit without its RETENTION_PURGED audit row. We force the
 * FAILED-branch transaction to throw AFTER the SENT-branch transaction has
 * committed (via a thin test-side Prisma proxy that lets the FIRST $transaction
 * call through and rejects the SECOND — NEVER by editing the worker), then
 * assert the SENT branch's DELETE + its audit row survived as a committed unit.
 *
 * writeDirectAuditLogInTx is private — every assertion reads audit_logs from the
 * DB, never by importing it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { NIL_UUID } from "@/lib/constants/app";
import { purgeRetention } from "@/workers/audit-outbox-worker";
import type { PrismaClient } from "@prisma/client";

describe("audit-outbox retention purge — per-branch atomic audit emission (Finding 1)", () => {
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

  // Copied from audit-outbox-sweep-caps.integration.test.ts: a SENT row aged
  // past RETENTION_HOURS (sent_at cutoff) so the SENT branch purges it.
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

  // A FAILED row aged past FAILED_RETENTION_DAYS (created_at cutoff) so the
  // FAILED branch purges it.
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

  /** All RETENTION_PURGED audit_logs rows scoped to THIS test's tenant. */
  async function retentionPurgedEvents(): Promise<
    Array<{
      metadata: Record<string, unknown>;
      actor_type: string;
      user_id: string;
      scope: string;
      chain_seq: bigint | null;
      outbox_id: string | null;
    }>
  > {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe(
        `SELECT metadata, actor_type::text AS actor_type, user_id::text AS user_id,
                scope::text AS scope, chain_seq, outbox_id::text AS outbox_id
         FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED,
      );
    });
  }

  async function survivingOutboxIds(ids: string[]): Promise<string[]> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_outbox WHERE id = ANY($1::uuid[])`,
        ids,
      );
    });
    return rows.map((r) => r.id);
  }

  it("emits exactly TWO RETENTION_PURGED events (one per branch) with matching per-branch purgedCount, each SYSTEM-actor and unchained (INV3)", async () => {
    // 2 SENT-aged rows + 3 FAILED-aged rows → SENT branch purges 2, FAILED
    // branch purges 3. purgeRetention default limit (1000) drains both fully.
    const sentIds = [await insertSentAgedRow(), await insertSentAgedRow()];
    const failedIds = [
      await insertFailedAgedRow(),
      await insertFailedAgedRow(),
      await insertFailedAgedRow(),
    ];

    await purgeRetention(ctx.su.prisma);

    // Both branches purged everything.
    expect(await survivingOutboxIds([...sentIds, ...failedIds])).toEqual([]);

    const events = await retentionPurgedEvents();
    // Exactly one event per branch that purged > 0.
    expect(events).toHaveLength(2);

    const purgedCounts = events
      .map((e) => Number((e.metadata as { purgedCount: number }).purgedCount))
      .sort((a, b) => a - b);
    // SENT branch count (2) and FAILED branch count (3), independently emitted.
    expect(purgedCounts).toEqual([2, 3]);

    // INV3: the direct-write path stays unchained and is a SYSTEM-actor row.
    for (const e of events) {
      expect(e.actor_type).toBe(ACTOR_TYPE.SYSTEM);
      expect(e.user_id).toBe("00000000-0000-4000-8000-000000000001"); // SYSTEM_ACTOR_ID
      expect(e.scope).toBe(AUDIT_SCOPE.TENANT);
      expect(e.chain_seq).toBeNull();
      expect(e.outbox_id).toBeNull();
    }
  });

  it("attributes purge audit per tenant — each tenant gets its OWN event with only its OWN count (Finding M1)", async () => {
    // A single purge batch spans two tenants. The fix replaced MIN(tenant_id)
    // (which attributed the whole batch to one tenant and leaked the others'
    // counts) with a per-tenant GROUP BY: each tenant must get exactly one
    // RETENTION_PURGED event carrying only that tenant's purgedCount.
    const otherTenantId = await ctx.createTenant();
    const insertSentAgedRowFor = async (tid: string): Promise<string> => {
      const id = randomUUID();
      const retentionHours = AUDIT_OUTBOX.RETENTION_HOURS;
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at, sent_at)
           VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', 1, 8, now() - interval '48 hours', now(),
                   now() - make_interval(hours => $4) - interval '1 hour')`,
          id,
          tid,
          makePayload(),
          retentionHours,
        );
      });
      return id;
    };
    const purgedEventsFor = async (tid: string) =>
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<Array<{ metadata: Record<string, unknown> }>>(
          `SELECT metadata FROM audit_logs WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
          tid,
          AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED,
        );
      });

    try {
      // 1 aged SENT row for this tenant, 2 for the other — same batch.
      await insertSentAgedRowFor(tenantId);
      await insertSentAgedRowFor(otherTenantId);
      await insertSentAgedRowFor(otherTenantId);

      await purgeRetention(ctx.su.prisma);

      const mine = await purgedEventsFor(tenantId);
      const theirs = await purgedEventsFor(otherTenantId);

      // Each tenant: exactly one event, carrying ONLY its own count.
      expect(mine).toHaveLength(1);
      expect(Number((mine[0]!.metadata as { purgedCount: number }).purgedCount)).toBe(1);
      expect(theirs).toHaveLength(1);
      expect(Number((theirs[0]!.metadata as { purgedCount: number }).purgedCount)).toBe(2);
    } finally {
      await ctx.deleteTestData(otherTenantId);
    }
  });

  it("emits exactly ONE RETENTION_PURGED event when only the SENT branch has eligible rows", async () => {
    // Only SENT-aged rows; the FAILED branch purges 0 and emits nothing.
    const sentIds = [await insertSentAgedRow(), await insertSentAgedRow()];

    await purgeRetention(ctx.su.prisma);

    expect(await survivingOutboxIds(sentIds)).toEqual([]);

    const events = await retentionPurgedEvents();
    expect(events).toHaveLength(1);
    expect(
      Number((events[0]!.metadata as { purgedCount: number }).purgedCount),
    ).toBe(2);
  });

  it("SENT branch delete + its audit row commit atomically and survive a FAILED-branch failure (core Finding-1 regression)", async () => {
    const sentIds = [await insertSentAgedRow(), await insertSentAgedRow()];
    // A FAILED-aged row exists so the FAILED branch would normally purge it —
    // but we make its transaction throw before it can commit.
    const failedId = await insertFailedAgedRow();

    // Thin test-side proxy over the real Prisma client. purgeRetention issues
    // its branch transactions as sequential $transaction calls: SENT first,
    // FAILED second, then a delivery-purge tx third. We let the FIRST call
    // (SENT branch) run against the real client so it commits normally, then
    // reject the SECOND call (FAILED branch) so its tx never commits. This
    // forces exactly the partial-failure scenario Finding 1 guards WITHOUT
    // touching any production code.
    let txCall = 0;
    const failedBranchError = new Error("injected: FAILED-branch transaction failure");
    const proxy = new Proxy(ctx.su.prisma, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return (...args: unknown[]) => {
            txCall += 1;
            if (txCall === 2) {
              // FAILED-branch tx — reject before it can DELETE/commit.
              return Promise.reject(failedBranchError);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target.$transaction as any)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as PrismaClient;

    // (c) The overall purge rejects because the FAILED-branch failure propagates.
    await expect(purgeRetention(proxy)).rejects.toThrow(failedBranchError);

    // (a) The SENT-aged rows ARE deleted — the SENT branch committed before the
    // FAILED branch threw.
    expect(await survivingOutboxIds(sentIds)).toEqual([]);
    // The FAILED-aged row is untouched — its branch tx never ran to completion.
    expect(await survivingOutboxIds([failedId])).toEqual([failedId]);

    // (b) Exactly ONE RETENTION_PURGED audit row exists, with purgedCount = the
    // SENT count (2). This is the load-bearing proof: the destructive SENT
    // DELETE did not lose its audit trail even though the overall purge failed.
    const events = await retentionPurgedEvents();
    expect(events).toHaveLength(1);
    expect(
      Number((events[0]!.metadata as { purgedCount: number }).purgedCount),
    ).toBe(2);
    expect(events[0]!.actor_type).toBe(ACTOR_TYPE.SYSTEM);
    expect(events[0]!.chain_seq).toBeNull();
    expect(events[0]!.outbox_id).toBeNull();

    // Guard against a stray NIL-UUID tenant leaking into the assertion set.
    expect(tenantId).not.toBe(NIL_UUID);
  });
});
