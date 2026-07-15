/**
 * C6 (M-f): pins the invariant that worker operational events
 * (AUDIT_OUTBOX_DEAD_LETTER emitted by the reaper) are unchained —
 * chain_seq/event_hash/chain_prev_hash/outbox_id all NULL — and never
 * advance the tenant's audit_chain_anchors row, even on a chain-enabled
 * tenant. Uses the real exported reapStuckRows (RT5 — real call path),
 * not a hand-rolled copy of the reaper SQL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_OUTBOX, AUDIT_ACTION, AUDIT_SCOPE, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { deliverRowWithChain, reapStuckRows } from "@/workers/audit-outbox-worker";
import type { AuditOutboxRow, AuditOutboxPayload } from "@/workers/audit-outbox-worker";
import { verifyTenantChain } from "../../../scripts/audit-chain-verify-worker";

describe("audit-outbox dead-letter — unchained invariant (C6/M-f)", () => {
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

    // Chain-enabled tenant — the dead-letter bypass must hold even here.
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

  async function insertAndClaim(payload: AuditOutboxPayload): Promise<AuditOutboxRow> {
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

  /** Insert a stuck PROCESSING row one attempt away from dead-lettering. */
  async function insertStuckAboutToDie(): Promise<string> {
    const outboxId = randomUUID();
    const maxAttempts = 8;
    const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, attempt_count, max_attempts, processing_started_at, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', $4, $5,
                 now() - make_interval(secs => $6::double precision) - interval '60 seconds',
                 now(), now())`,
        outboxId,
        tenantId,
        JSON.stringify(makePayload()),
        maxAttempts - 1,
        maxAttempts,
        timeoutSeconds,
      );
    });
    return outboxId;
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

  it("dead-letters the stuck row and writes an unchained AUDIT_OUTBOX_DEAD_LETTER event", async () => {
    // Anchor a genuine chained row first (chain_seq -> 1).
    const anchorRow = await insertAndClaim(makePayload());
    const anchorDelivered = await deliverRowWithChain(ctx.su.prisma, anchorRow, makePayload());
    expect(anchorDelivered.delivered).toBe(true);
    expect(await getAnchorChainSeq()).toBe(1);

    const stuckOutboxId = await insertStuckAboutToDie();

    const reaped = await reapStuckRows(ctx.su.prisma);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const stuckRow = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status::text FROM audit_outbox WHERE id = $1::uuid`,
        stuckOutboxId,
      );
    });
    expect(stuckRow[0]?.status).toBe("FAILED");

    const deadLetterLogs = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        {
          chain_seq: bigint | null;
          event_hash: Buffer | null;
          chain_prev_hash: Buffer | null;
          outbox_id: string | null;
          actor_type: string;
          user_id: string | null;
          metadata: unknown;
        }[]
      >(
        `SELECT chain_seq, event_hash, chain_prev_hash, outbox_id, actor_type::text, user_id, metadata
         FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
      );
    });

    expect(deadLetterLogs).toHaveLength(1);
    const log = deadLetterLogs[0]!;
    expect(log.chain_seq).toBeNull();
    expect(log.event_hash).toBeNull();
    expect(log.chain_prev_hash).toBeNull();
    expect(log.outbox_id).toBeNull();
    expect(log.actor_type).toBe("SYSTEM");
    expect(log.user_id).toBe(SYSTEM_ACTOR_ID);
    expect((log.metadata as { outboxId: string }).outboxId).toBe(stuckOutboxId);
  });

  it("does not advance the tenant's chain anchor when dead-lettering", async () => {
    const anchorRow = await insertAndClaim(makePayload());
    await deliverRowWithChain(ctx.su.prisma, anchorRow, makePayload());
    expect(await getAnchorChainSeq()).toBe(1);

    await insertStuckAboutToDie();
    await reapStuckRows(ctx.su.prisma);

    // Dead-lettering must never touch audit_chain_anchors.
    expect(await getAnchorChainSeq()).toBe(1);
  });

  it("non-vacuous chain continuity: a genuine 2nd chained delivery after the dead-letter still verifies ok with walkedThrough=2", async () => {
    const anchorRow = await insertAndClaim(makePayload());
    await deliverRowWithChain(ctx.su.prisma, anchorRow, makePayload());
    expect(await getAnchorChainSeq()).toBe(1);

    await insertStuckAboutToDie();
    await reapStuckRows(ctx.su.prisma);
    expect(await getAnchorChainSeq()).toBe(1);

    // Deliver a second genuine chained row — anchor should advance to 2,
    // proving the unchained dead-letter row neither entered the walk nor
    // broke the hash linkage between chain_seq 1 and 2.
    const secondRow = await insertAndClaim(makePayload());
    const secondDelivered = await deliverRowWithChain(ctx.su.prisma, secondRow, makePayload());
    expect(secondDelivered.delivered).toBe(true);
    expect(await getAnchorChainSeq()).toBe(2);

    // verifyTenantChain issues a bare (non-transactional) SELECT against
    // audit_logs, which carries an RLS policy scoped to app.tenant_id /
    // app.bypass_rls. Those GUCs are transaction-local (set_config(..., true)),
    // so the bypass must be set in the SAME transaction as the verify query —
    // run it through $transaction with a structural TransactionClient->
    // PrismaClient cast (verifyTenantChain only calls .$queryRawUnsafe, which
    // both expose identically).
    const result = await ctx.worker.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return verifyTenantChain(tenantId, {
        prisma: tx as unknown as PrismaClient,
        logger: { error: () => {}, info: () => {} },
      });
    });

    expect(result.walkedThrough).toBe(2);
    expect(result.ok).toBe(true);
  });
});
