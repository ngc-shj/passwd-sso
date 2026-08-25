/**
 * Periodic audit-chain integrity verification worker.
 *
 * Walks every tenant's audit_logs chain hourly and emits:
 *   - CHAIN_VERIFY_HEARTBEAT (success path, every tick) so operators can
 *     detect a silent worker crash via "no heartbeat in 2h" alarm.
 *   - CHAIN_VERIFY_FAILED (on tamper / gap detection) with hysteresis:
 *     re-emit only when the tenant's state transitions clean → failed
 *     OR every 24h while still in failed state.
 *
 * Process lifecycle: long-running (sleep TICK_INTERVAL_MS between rounds).
 * Run as `npm run worker:audit-chain-verify` or `audit-chain-verify-worker`
 * docker-compose service. Uses the standard prisma client (passwd_app role).
 *
 * That role retains SELECT on audit_logs after the C13 REVOKE, but SELECT
 * PRIVILEGE IS NOT RLS VISIBILITY: passwd_app is NOBYPASSRLS, and both
 * audit_logs and audit_chain_anchors are FORCE ROW LEVEL SECURITY with
 * `bypass_rls='on' OR tenant_id = current_setting('app.tenant_id',true)::uuid`.
 * With the GUC unset the predicate is NULL and every read returns zero rows
 * WITH NO ERROR — so the walk finds nothing wrong and reports every tenant
 * healthy. Reads therefore run inside withTenantRls, which sets app.tenant_id
 * for the tenant being verified; that matches the `WHERE tenant_id = $1` these
 * queries already carry, and is tighter than a blanket bypass.
 *
 * This failure mode is silent by construction — unlike the audit_outbox case,
 * which raised 22P02 once a GUC had been touched on the connection. Hence the
 * GUC precondition assertion below and the heartbeat suppression in runTick:
 * an inert verifier must not be able to report healthy.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import { resolve } from "node:path";
import {
  verifyChainRows,
  GENESIS_PREV_HASH,
  CHAIN_VERIFY_REASON,
  type ChainVerifyReason,
} from "@/lib/audit/audit-chain-verify";
import { MS_PER_HOUR, MS_PER_DAY } from "@/lib/constants/time";
import { withTenantRls } from "@/lib/tenant-rls";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });

const TICK_INTERVAL_MS = Number(
  process.env.AUDIT_CHAIN_VERIFY_TICK_INTERVAL_MS ?? MS_PER_HOUR,
);
const HYSTERESIS_REALERT_MS = Number(
  process.env.AUDIT_CHAIN_VERIFY_REALERT_MS ?? MS_PER_DAY,
);
const MAX_ROWS_PER_TENANT = Number(
  process.env.AUDIT_CHAIN_VERIFY_MAX_ROWS ?? 100_000,
);

export interface VerifyResult {
  tenantId: string;
  ok: boolean;
  reason?: ChainVerifyReason;
  totalVerified: number;
  walkedThrough: number;
  firstTamperedSeq: number | null;
  firstGapAfterSeq: number | null;
  firstTimestampViolationSeq: number | null;
  firstBrokenLinkSeq: number | null;
  anchorChecked: boolean;
}

interface ChainRowRaw {
  id: string;
  tenant_id: string;
  created_at: Date;
  chain_seq: bigint;
  event_hash: Uint8Array;
  chain_prev_hash: Uint8Array | null;
  metadata: unknown;
}

interface AnchorRow {
  chain_seq: string;
  prev_hash: Uint8Array;
}

export interface VerifyDeps {
  prisma: PrismaClient;
  logger: { error: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}

export async function verifyTenantChain(
  tenantId: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  return withTenantRls(deps.prisma, tenantId, async (tx) => {
    // Precondition, asserted rather than assumed. Every read below returns
    // zero rows with no error when app.tenant_id is unset, so "the wrapper
    // was removed" and "this tenant has no audit rows" are indistinguishable
    // from the result alone. This is the assertion that makes a future
    // refactor loud instead of silently reinstating the inert verifier.
    const [guc] = await tx.$queryRawUnsafe<Array<{ tenant_id: string | null }>>(
      `SELECT current_setting('app.tenant_id', true) AS tenant_id`,
    );
    if (guc?.tenant_id !== tenantId) {
      throw new Error(
        `RLS_CONTEXT_MISSING: app.tenant_id is ${JSON.stringify(
          guc?.tenant_id ?? null,
        )}, expected ${tenantId} — reads would silently return zero rows`,
      );
    }

    // The anchor is read first and for the same reason the endpoint reads it:
    // without it, a tenant whose rows were all deleted walks zero rows, finds
    // nothing wrong, and reports healthy — which is precisely the state periodic
    // monitoring exists to notice.
    const anchors = await tx.$queryRawUnsafe<AnchorRow[]>(
      `SELECT chain_seq, prev_hash FROM audit_chain_anchors WHERE tenant_id = $1`,
      tenantId,
    );

    if (anchors.length === 0) {
      const counted = await tx.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE tenant_id = $1
           AND chain_seq IS NOT NULL`,
        tenantId,
      );
      const chainedRows = Number(counted[0]?.count ?? 0);
      return {
        tenantId,
        ok: chainedRows === 0,
        reason:
          chainedRows === 0 ? undefined : CHAIN_VERIFY_REASON.ANCHOR_MISSING,
        totalVerified: 0,
        walkedThrough: 0,
        firstTamperedSeq: null,
        firstGapAfterSeq: null,
        firstTimestampViolationSeq: null,
        firstBrokenLinkSeq: null,
        anchorChecked: false,
      };
    }

    const anchorSeq = Number(anchors[0].chain_seq);

    // Bounded by the anchor's seq, matching the endpoint's query. The anchor is
    // read first, so on a tenant still writing audit rows the walk would
    // otherwise pick up rows appended after it — ending on a hash later than the
    // head the anchor recorded, and reporting ANCHOR_HASH_MISMATCH for a
    // perfectly healthy chain. On the monitoring path that is a page in the
    // middle of the night for nothing, and worse, it trains the reader to
    // discount the alert that matters.
    const rows = await tx.$queryRawUnsafe<ChainRowRaw[]>(
      `SELECT id, tenant_id, created_at,
              chain_seq, event_hash, chain_prev_hash, metadata
       FROM audit_logs
       WHERE tenant_id = $1
         AND chain_seq IS NOT NULL
         AND chain_seq <= $2
       ORDER BY chain_seq ASC
       LIMIT $3`,
      tenantId,
      BigInt(anchorSeq),
      MAX_ROWS_PER_TENANT,
    );

    const outcome = verifyChainRows({
      rows,
      seedPrevHash: GENESIS_PREV_HASH,
      fromSeq: 1,
      toSeq: anchorSeq,
      anchorPrevHash: anchors[0].prev_hash,
      // The worker always walks the whole chain, so the head hash is always
      // comparable — this is the only caller that can catch a full rewrite.
      anchorComparable: true,
      rowCap: MAX_ROWS_PER_TENANT,
    });

    return {
      tenantId,
      ok: outcome.ok,
      reason: outcome.reason,
      totalVerified: outcome.totalVerified,
      walkedThrough: outcome.walkedThrough,
      firstTamperedSeq: outcome.firstTamperedSeq,
      firstGapAfterSeq: outcome.firstGapAfterSeq,
      firstTimestampViolationSeq: outcome.firstTimestampViolationSeq,
      firstBrokenLinkSeq: outcome.firstBrokenLinkSeq,
      anchorChecked: outcome.anchorChecked,
    };
  });
}

// ── Worker main loop ─────────────────────────────────────────────

interface TenantState {
  lastAlertAt: number | null;
  inFailedState: boolean;
}

export async function runTick(
  prisma: PrismaClient,
  states: Map<string, TenantState>,
): Promise<void> {
  // `tenants` carries no tenant_isolation policy (it is the tenancy root), so
  // this read needs no RLS context — unlike everything verifyTenantChain reads.
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  const logger = console;
  let verified = 0;
  let errored = 0;

  for (const { id: tenantId } of tenants) {
    try {
      const result = await verifyTenantChain(tenantId, { prisma, logger });
      const state = states.get(tenantId) ?? {
        lastAlertAt: null,
        inFailedState: false,
      };

      if (!result.ok) {
        const now = Date.now();
        const shouldAlert =
          !state.inFailedState ||
          (state.lastAlertAt !== null &&
            now - state.lastAlertAt >= HYSTERESIS_REALERT_MS);
        if (shouldAlert) {
          // reason carries the discriminator: with only firstTamperedSeq an
          // ANCHOR_MISSING or RANGE_INCOMPLETE failure logs a null seq and
          // reads like noise, which is the opposite of what a chain alert is
          // for. anchorChecked says whether the head-hash comparison ran.
          logger.error(
            "audit-chain-verify-worker: CHAIN_VERIFY_FAILED tenant=%s reason=%s firstTamperedSeq=%s firstGapAfterSeq=%s firstBrokenLinkSeq=%s walkedThrough=%d anchorChecked=%s",
            tenantId,
            result.reason ?? "UNKNOWN",
            result.firstTamperedSeq,
            result.firstGapAfterSeq,
            result.firstBrokenLinkSeq,
            result.walkedThrough,
            result.anchorChecked,
          );
          state.lastAlertAt = now;
        }
        state.inFailedState = true;
      } else {
        state.inFailedState = false;
        state.lastAlertAt = null;
      }
      states.set(tenantId, state);
      verified++;
    } catch (err) {
      errored++;
      logger.error(
        "audit-chain-verify-worker: tenant=%s verify threw: %O",
        tenantId,
        err,
      );
    }
  }

  // Heartbeat: emit a single console log per tick so operators can detect
  // silent worker crashes via "no heartbeat in 2h" alarm.
  //
  // Withheld when any tenant failed to verify. The absence alarm is the only
  // signal an operator has, so emitting it after a tick that verified nothing
  // would manufacture assurance — exactly the state that let an inert verifier
  // report healthy. "Examined nothing" must not be spelled like "found nothing
  // wrong": a partial tick is a failed tick.
  if (errored > 0) {
    logger.error(
      "audit-chain-verify-worker: tick incomplete — %d/%d tenants failed to verify; heartbeat withheld",
      errored,
      tenants.length,
    );
    return;
  }

  console.log(
    JSON.stringify({
      level: "info",
      _logType: "audit-chain-verify-heartbeat",
      tenantCount: tenants.length,
      // Present so the heartbeat carries what it actually covered rather than
      // only that the process is alive.
      verifiedTenantCount: verified,
      time: new Date().toISOString(),
    }),
  );
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.AUDIT_CHAIN_VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("AUDIT_CHAIN_VERIFY_DATABASE_URL or DATABASE_URL required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const states = new Map<string, TenantState>();
  const stop = { value: false };
  process.on("SIGTERM", () => { stop.value = true; });
  process.on("SIGINT", () => { stop.value = true; });

  console.log(
    `audit-chain-verify-worker: starting (tick=${TICK_INTERVAL_MS}ms)`,
  );

  while (!stop.value) {
    try {
      await runTick(prisma, states);
    } catch (err) {
      console.error("audit-chain-verify-worker: tick threw:", err);
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }

  await prisma.$disconnect();
  await pool.end();
  console.log("audit-chain-verify-worker: shutdown clean");
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("audit-chain-verify-worker.ts") ||
    process.argv[1].endsWith("audit-chain-verify-worker.js"))
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
