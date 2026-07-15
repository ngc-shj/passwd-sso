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
import {
  deliverRowWithChain,
  reapStuckRows,
  reapStuckDeliveries,
  reapStuckWebhookDeliveries,
} from "@/workers/audit-outbox-worker";
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

  it("Nit-1 atomicity: if the reaper's DEAD_LETTER audit insert fails, the reap transition rolls back (row stays PROCESSING, no audit row)", async () => {
    // The dead-letter audit now commits in the SAME tx as the FAILED transition.
    // Inject a fault into the in-tx audit_logs INSERT and assert the whole tx
    // rolls back: the stuck row must NOT be left FAILED without its audit trail.
    const stuckOutboxId = await insertStuckAboutToDie();

    // Proxy the Prisma client so the reaper's $transaction runs against the real
    // client, but the tx client's $executeRawUnsafe throws when it targets
    // audit_logs (the writeDirectAuditLogInTx insert) — never by editing the
    // worker.
    const injected = new Error("injected: audit_logs insert failure");
    const proxy = new Proxy(ctx.su.prisma, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (fn: (tx: any) => unknown, ...rest: unknown[]) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (target.$transaction as any)((tx: any) => {
              const txProxy = new Proxy(tx, {
                get(t, p, r) {
                  if (p === "$executeRawUnsafe") {
                    return (sql: string, ...args: unknown[]) => {
                      if (
                        typeof sql === "string" &&
                        sql.includes("INSERT INTO audit_logs")
                      ) {
                        return Promise.reject(injected);
                      }
                      return t.$executeRawUnsafe(sql, ...args);
                    };
                  }
                  return Reflect.get(t, p, r);
                },
              });
              return fn(txProxy);
            }, ...rest);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as PrismaClient;

    await expect(reapStuckRows(proxy)).rejects.toThrow(injected);

    // The reap transition rolled back: the row is still PROCESSING, not FAILED.
    const rowAfter = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status::text FROM audit_outbox WHERE id = $1::uuid`,
        stuckOutboxId,
      );
    });
    expect(rowAfter[0]?.status).toBe("PROCESSING");

    // No dead-letter audit row was committed.
    const logs = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
      );
    });
    expect(Number(logs[0]?.n ?? 0)).toBe(0);
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

// ─── F3: sibling reapers emit a dead-letter audit (class-completeness sweep) ──
//
// reapStuckDeliveries (audit_deliveries) and reapStuckWebhookDeliveries
// (webhook_deliveries) also transition rows to FAILED when they exceed
// max_attempts. Parity with reapStuckRows: that terminal transition must emit a
// dead-letter audit, co-committed in the reap tx.
describe("sibling reapers — reaper-driven dead-letter audit (F3)", () => {
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

  const staleCutoffSql =
    "now() - make_interval(secs => $STALE::double precision) - interval '60 seconds'";

  async function insertStuckDelivery(atMax: boolean): Promise<string> {
    const id = randomUUID();
    const outboxId = randomUUID();
    const targetId = randomUUID();
    const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // Minimal outbox + target to satisfy any incidental reads; the reaper
      // itself only touches audit_deliveries.
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}'::jsonb, 'SENT', now())`,
        outboxId,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
           id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
           master_key_version, is_active, created_at
         ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK'::"AuditDeliveryTargetKind", 'e','i','t', 1, true, now())`,
        targetId,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status, attempt_count, max_attempts, processing_started_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PROCESSING', $5, 8,
                 ${staleCutoffSql.replace("$STALE", "$6")})`,
        id,
        outboxId,
        targetId,
        tenantId,
        atMax ? 7 : 1,
        timeoutSeconds,
      );
    });
    return id;
  }

  async function insertStuckWebhookDelivery(atMax: boolean): Promise<string> {
    const id = randomUUID();
    const outboxId = randomUUID();
    const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO webhook_deliveries (id, outbox_id, tenant_id, scope, team_id, action, status, attempt_count, max_attempts, processing_started_at, next_retry_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'TENANT'::"WebhookDeliveryScope", NULL, 'ADMIN_VAULT_RESET_INITIATE', 'PROCESSING', $4, 8,
                 ${staleCutoffSql.replace("$STALE", "$5")}, now(), now())`,
        id,
        outboxId,
        tenantId,
        atMax ? 7 : 1,
        timeoutSeconds,
      );
    });
    return id;
  }

  async function auditCount(action: string): Promise<number> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantId,
        action,
      );
    });
    return Number(rows[0]?.n ?? 0);
  }

  it("reapStuckDeliveries emits AUDIT_DELIVERY_DEAD_LETTER only for rows that hit FAILED", async () => {
    const dying = await insertStuckDelivery(true); // attempt 7 → +1 = 8 = max → FAILED
    await insertStuckDelivery(false); // attempt 1 → +1 = 2 → PENDING, no audit

    const reaped = await reapStuckDeliveries(ctx.su.prisma);
    expect(reaped).toBe(2);

    const status = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status::text FROM audit_deliveries WHERE id = $1::uuid`,
        dying,
      );
    });
    expect(status[0]?.status).toBe("FAILED");
    // Exactly one dead-letter audit — for the FAILED row, not the PENDING one.
    expect(await auditCount(AUDIT_ACTION.AUDIT_DELIVERY_DEAD_LETTER)).toBe(1);
  });

  it("reapStuckWebhookDeliveries emits AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER only for rows that hit FAILED", async () => {
    const dying = await insertStuckWebhookDelivery(true);
    await insertStuckWebhookDelivery(false);

    const reaped = await reapStuckWebhookDeliveries(ctx.su.prisma);
    expect(reaped).toBe(2);

    const status = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status::text FROM webhook_deliveries WHERE id = $1::uuid`,
        dying,
      );
    });
    expect(status[0]?.status).toBe("FAILED");
    expect(await auditCount(AUDIT_ACTION.AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER)).toBe(1);
  });

  it("F3-atomicity: if the webhook-reaper's dead-letter audit insert fails, the FAILED transition rolls back (row stays PROCESSING, no audit)", async () => {
    const dying = await insertStuckWebhookDelivery(true);

    const injected = new Error("injected: audit_logs insert failure");
    const proxy = new Proxy(ctx.su.prisma, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (fn: (tx: any) => unknown, ...rest: unknown[]) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (target.$transaction as any)((tx: any) => {
              const txProxy = new Proxy(tx, {
                get(t, p, r) {
                  if (p === "$executeRawUnsafe") {
                    return (sql: string, ...args: unknown[]) => {
                      if (typeof sql === "string" && sql.includes("INSERT INTO audit_logs")) {
                        return Promise.reject(injected);
                      }
                      return t.$executeRawUnsafe(sql, ...args);
                    };
                  }
                  return Reflect.get(t, p, r);
                },
              });
              return fn(txProxy);
            }, ...rest);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as PrismaClient;

    await expect(reapStuckWebhookDeliveries(proxy)).rejects.toThrow(injected);

    const status = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status::text FROM webhook_deliveries WHERE id = $1::uuid`,
        dying,
      );
    });
    expect(status[0]?.status).toBe("PROCESSING");
    expect(await auditCount(AUDIT_ACTION.AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER)).toBe(0);
  });
});
