/**
 * C7 (M-c): the missing concurrent same-row delivery idempotency race test.
 * Two worker-role clients race deliverRowWithChain against the SAME claimed
 * outbox row on a chain-enabled tenant. deliverRowWithChain's own anchor
 * SELECT ... FOR UPDATE (audit-outbox-worker.ts:239) serializes the two
 * transactions — the second waits on the first's lock, or times out via
 * SET LOCAL lock_timeout='5000ms' (:211) under contention.
 *
 * Non-vacuous guard (T1): "both returned delivered:true" is NOT sufficient —
 * deliverRowWithChain returns delivered:true unconditionally on any
 * non-paused delivery, so two serial calls both return delivered:true too.
 * The real guard is the `inserted` discriminator: exactly one call's
 * INSERT ... ON CONFLICT (outbox_id) DO NOTHING RETURNING id must have won
 * (inserted:true) and the other must have conflicted (inserted:false). A
 * broken interleave where both transactions insert (and both advance the
 * anchor) would violate this; a serial run cannot fake it either, since the
 * second serial delivery still conflicts (inserted:false).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  createPrismaForRole,
  setBypassRlsGucs,
  raceTwoClients,
  type TestContext,
  type PrismaWithPool,
} from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { deliverRowWithChain } from "@/workers/audit-outbox-worker";
import type { AuditOutboxRow, AuditOutboxPayload } from "@/workers/audit-outbox-worker";

/**
 * PG error code 55P03 = lock_not_available (our SET LOCAL lock_timeout).
 * Prisma may surface this as a direct code, a P2010 meta.code, or wrapped
 * in err.cause.code — same detection shape as
 * src/lib/auth/policy/account-lockout.ts's private isLockTimeoutError.
 */
function isLockTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase().includes("lock_timeout") || message.toLowerCase().includes("lock timeout")) {
    return true;
  }
  if ("code" in err && (err as { code: string }).code === "55P03") return true;
  if (
    "code" in err &&
    (err as { code: string }).code === "P2010" &&
    "meta" in err &&
    err.meta &&
    typeof err.meta === "object" &&
    "code" in err.meta &&
    (err.meta as { code: string }).code === "55P03"
  ) {
    return true;
  }
  if (
    "cause" in err &&
    err.cause &&
    typeof err.cause === "object" &&
    "code" in err.cause &&
    (err.cause as { code: string }).code === "55P03"
  ) {
    return true;
  }
  return false;
}

describe("audit-outbox concurrent same-row delivery (C7/M-c)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let clientA: PrismaWithPool;
  let clientB: PrismaWithPool;

  beforeAll(async () => {
    ctx = await createTestContext();
    clientA = createPrismaForRole("worker");
    clientB = createPrismaForRole("worker");
  });

  afterAll(async () => {
    await Promise.all([
      clientA.prisma.$disconnect().then(() => clientA.pool.end()),
      clientB.prisma.$disconnect().then(() => clientB.pool.end()),
    ]);
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);

    await ctx.su.prisma.$transaction(async (tx) => {
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

  function makePayload(): AuditOutboxPayload {
    return {
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId,
      actorType: ACTOR_TYPE.HUMAN,
      serviceAccountId: null,
      teamId: null,
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
    };
  }

  /** Insert a single PROCESSING outbox row as if already claimed by the worker. */
  async function insertClaimedRow(payload: AuditOutboxPayload): Promise<AuditOutboxRow> {
    const outboxId = randomUUID();
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<AuditOutboxRow[]>(
        `INSERT INTO audit_outbox
           (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 5, now(), now())
         RETURNING *`,
        outboxId,
        tenantId,
        JSON.stringify(payload),
      );
      return rows[0]!;
    });
  }

  async function countAuditLogsFor(outboxId: string): Promise<number> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_logs WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
    return Number(rows[0]!.cnt);
  }

  async function getAnchorChainSeq(): Promise<number> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    return Number(rows[0]?.chain_seq ?? 0);
  }

  /**
   * Run one race attempt; returns "ok" with the outcome, or "inconclusive"
   * if either side hit lock_timeout (retry, never assert-pass on it — a
   * timeout means that side never completed, so it cannot have produced a
   * false double-insert).
   */
  async function attemptRace(): Promise<
    | { kind: "ok"; insertedFlags: [boolean, boolean]; outboxId: string }
    | { kind: "inconclusive" }
  > {
    const payload = makePayload();
    const row = await insertClaimedRow(payload);

    try {
      const [resultA, resultB] = await raceTwoClients(
        clientA.prisma,
        clientB.prisma,
        (c) => deliverRowWithChain(c, row, payload),
        (c) => deliverRowWithChain(c, row, payload),
      );
      return {
        kind: "ok",
        insertedFlags: [resultA.inserted, resultB.inserted],
        outboxId: row.id,
      };
    } catch (err) {
      if (isLockTimeoutError(err)) {
        return { kind: "inconclusive" };
      }
      throw err;
    }
  }

  it("exactly one of two concurrent deliveries wins the INSERT (inserted discriminator, RT4)", async () => {
    const MAX_ATTEMPTS = 5;
    let concluded = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !concluded; attempt++) {
      const result = await attemptRace();
      if (result.kind === "inconclusive") {
        // Neither call completed within lock_timeout — retry with a fresh row.
        continue;
      }
      concluded = true;

      const [insertedA, insertedB] = result.insertedFlags;
      // PRIMARY non-vacuous guard: exactly one side actually won the INSERT.
      // A broken interleave where both transactions insert (both advance the
      // anchor) would produce [true, true]; a bug that lets neither win
      // (e.g. an accidental early return) would produce [false, false].
      const insertedCount = [insertedA, insertedB].filter(Boolean).length;
      expect(insertedCount).toBe(1);

      // Exactly one audit_logs row landed for this outbox row.
      expect(await countAuditLogsFor(result.outboxId)).toBe(1);

      // Anchor advanced exactly once (not twice).
      expect(await getAnchorChainSeq()).toBe(1);
    }

    expect(concluded).toBe(true);
  });
});
