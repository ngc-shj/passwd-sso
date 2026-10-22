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
 * `rls_bypass_admits('<table>') OR tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid)`.
 * With the GUC unset the predicate is NULL and every read returns zero rows
 * WITH NO ERROR — so the walk finds nothing wrong and reports every tenant
 * healthy. Reads therefore run inside withTenantRls, which sets app.tenant_id
 * for the tenant being verified; that matches the `WHERE tenant_id = $1` these
 * queries already carry, and is tighter than a blanket bypass.
 *
 * The `__system__` sentinel is the exception: withTenantRls refuses it (a
 * context scoped to it would expose every unattributable audit row), so its
 * chain is read under the AUDIT_CHAIN_VERIFY_SENTINEL_READ bypass grant, which
 * names only audit_chain_anchors and audit_logs. That grant admits every
 * tenant's rows of those two tables; what confines the read to the sentinel is
 * the same `WHERE tenant_id = $1`, plus assertions on the rows that come back.
 *
 * This failure mode is silent by construction — unlike the audit_outbox case,
 * which raised 22P02 once a GUC had been touched on the connection. Hence the
 * GUC precondition assertion in verifyTenantChain: an inert verifier must not
 * be able to report healthy.
 *
 * Liveness and coverage are reported separately. The heartbeat is emitted every
 * tick and means only "the process ran"; how much it actually covered rides on
 * the same line as tenantCount / verifiedTenantCount / erroredTenantCount.
 * Withholding the heartbeat on a tenant failure would make one permanently
 * failing tenant indistinguishable from a dead worker, which is the same
 * manufactured assurance one layer up.
 */

import type { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { resolve } from "node:path";
import {
  verifyChainRows,
  GENESIS_PREV_HASH,
  CHAIN_VERIFY_REASON,
  type ChainVerifyReason,
} from "@/lib/audit/audit-chain-verify";
import { MS_PER_HOUR, MS_PER_DAY, MS_PER_MINUTE } from "@/lib/constants/time";
import { errorLogFields } from "@/lib/logger/error-fields";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { withBypassRls, withTenantRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT, readBypassState } from "@/lib/tenant-rls-grants";
import { createPool, createPrismaClient, registerBypassNoticeSink, stderrBypassNoticeSink } from "@/lib/db/pool-factory";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });

const TICK_INTERVAL_MS = Number(
  process.env.AUDIT_CHAIN_VERIFY_TICK_INTERVAL_MS ?? MS_PER_HOUR,
);
const HYSTERESIS_REALERT_MS = Number(
  process.env.AUDIT_CHAIN_VERIFY_REALERT_MS ?? MS_PER_DAY,
);
export const MAX_ROWS_PER_TENANT = Number(
  process.env.AUDIT_CHAIN_VERIFY_MAX_ROWS ?? 100_000,
);

// Stated, not inherited. Prisma's interactive-transaction default is 5s, which
// covers the 100k-row default read with headroom but not a raised
// AUDIT_CHAIN_VERIFY_MAX_ROWS — and the failure (P2028) is indistinguishable at
// the catch site from a real verification error, so it would land in the tick's
// errored count and read as a coverage gap rather than a timeout.
const CHAIN_VERIFY_TX_TIMEOUT_MS = Number(
  process.env.AUDIT_CHAIN_VERIFY_TX_TIMEOUT_MS ?? MS_PER_MINUTE,
);
const CHAIN_VERIFY_TX_MAX_WAIT_MS = 10_000;
const ERRORED_IDS_LOGGED = 20;

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
  tenant_id: string;
  chain_seq: string;
  prev_hash: Uint8Array;
}

export interface VerifyDeps {
  prisma: PrismaClient;
  logger: {
    error: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
}

type ChainRead =
  | { kind: "no-anchor"; chainedRows: number }
  | { kind: "walk"; anchorSeq: number; anchorPrevHash: Uint8Array; rows: ChainRowRaw[] };

type ReadTx = Pick<PrismaClient, "$queryRawUnsafe">;

/**
 * The reads both paths share. `checkScope` is the bypass path's: there the
 * policy admits every tenant's rows, so the rows that come back are checked
 * against the tenant being verified rather than trusted to the WHERE alone.
 */
async function readChain(tx: ReadTx, tenantId: string, checkScope: boolean): Promise<ChainRead> {
  // The anchor is read first and for the same reason the endpoint reads it:
  // without it, a tenant whose rows were all deleted walks zero rows, finds
  // nothing wrong, and reports healthy — which is precisely the state periodic
  // monitoring exists to notice.
  const anchors = await tx.$queryRawUnsafe<AnchorRow[]>(
    `SELECT tenant_id, chain_seq, prev_hash FROM audit_chain_anchors WHERE tenant_id = $1`,
    tenantId,
  );
  if (checkScope) {
    const foreign = anchors.find((a) => a.tenant_id !== tenantId);
    if (anchors.length > 1 || foreign) {
      throw scopeViolation(tenantId, foreign?.tenant_id ?? tenantId, "audit_chain_anchors");
    }
  }

  if (anchors.length === 0) {
    const counted = await tx.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE tenant_id = $1
           AND chain_seq IS NOT NULL`,
      tenantId,
    );
    return { kind: "no-anchor", chainedRows: Number(counted[0]?.count ?? 0) };
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
  if (checkScope) {
    const foreign = rows.find((r) => r.tenant_id !== tenantId);
    if (foreign) throw scopeViolation(tenantId, foreign.tenant_id, "audit_logs");
  }

  return { kind: "walk", anchorSeq, anchorPrevHash: anchors[0].prev_hash, rows };
}

/** Carries tenant ids only — never a row id or metadata; it reaches stderr. */
function scopeViolation(expected: string, offending: string, table: string): Error {
  return new Error(
    `BYPASS_SCOPE_VIOLATION: ${table} returned a row of tenant ${JSON.stringify(offending)} ` +
      `while verifying ${JSON.stringify(expected)}`,
  );
}

function resultOf(tenantId: string, fetched: ChainRead): VerifyResult {
  if (fetched.kind === "no-anchor") {
    return {
      tenantId,
      ok: fetched.chainedRows === 0,
      reason:
        fetched.chainedRows === 0
          ? undefined
          : CHAIN_VERIFY_REASON.ANCHOR_MISSING,
      totalVerified: 0,
      walkedThrough: 0,
      firstTamperedSeq: null,
      firstGapAfterSeq: null,
      firstTimestampViolationSeq: null,
      firstBrokenLinkSeq: null,
      anchorChecked: false,
    };
  }

  // Outside the transaction: pure computation over rows already read.
  const outcome = verifyChainRows({
    rows: fetched.rows,
    seedPrevHash: GENESIS_PREV_HASH,
    fromSeq: 1,
    toSeq: fetched.anchorSeq,
    anchorPrevHash: fetched.anchorPrevHash,
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
}

const TX_BUDGET = {
  timeout: CHAIN_VERIFY_TX_TIMEOUT_MS,
  maxWait: CHAIN_VERIFY_TX_MAX_WAIT_MS,
};

export async function verifyTenantChain(
  tenantId: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  // The predicate withTenantRls refuses on: the sentinel cannot be opened as a
  // tenant context, so its chain is read under the named bypass instead.
  if (tenantId.toLowerCase() === SYSTEM_TENANT_ID) {
    return verifyChainUnderSentinelGrant(tenantId, deps);
  }

  // Only the READS hold the transaction. verifyChainRows is pure —
  // canonicalisation plus a SHA-256 per row, no DB — so leaving it inside the
  // callback would spend an operator-tunable amount of JS CPU inside Prisma's
  // interactive-transaction budget for no benefit. The budget is stated rather
  // than inherited: the default is 5s, and MAX_ROWS_PER_TENANT is the knob an
  // operator turns up for exactly the tenant whose walk is already the slowest.
  const fetched = await withTenantRls(
    deps.prisma,
    tenantId,
    async (tx) => {
      // Precondition, asserted rather than assumed. Every read below returns
      // zero rows with no error when app.tenant_id is unset, so "the wrapper
      // was removed" and "this tenant has no audit rows" are indistinguishable
      // from the result alone. This is the assertion that makes a future
      // refactor loud instead of silently reinstating the inert verifier.
      const [guc] = await tx.$queryRawUnsafe<
        Array<{ tenant_id: string | null }>
      >(`SELECT current_setting('app.tenant_id', true) AS tenant_id`);
      if (guc?.tenant_id !== tenantId) {
        throw new Error(
          `RLS_CONTEXT_MISSING: app.tenant_id is ${JSON.stringify(
            guc?.tenant_id ?? null,
          )}, expected ${tenantId} — reads would silently return zero rows`,
        );
      }
      return readChain(tx, tenantId, false);
    },
    TX_BUDGET,
  );
  return resultOf(tenantId, fetched);
}

/**
 * The sentinel's read path: the AUDIT_CHAIN_VERIFY_SENTINEL_READ bypass, with
 * the rows that come back checked against `tenantId`. Exported so integration
 * tests can run it on throwaway tenants rather than the shared sentinel; used
 * on any other tenant it still reads only that tenant's rows.
 */
export async function verifyChainUnderSentinelGrant(
  rawTenantId: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  // PostgreSQL returns uuids in lowercase; the row checks compare against
  // this one spelling, as the routing predicate does.
  const tenantId = rawTenantId.toLowerCase();
  const grant = BYPASS_GRANT.AUDIT_CHAIN_VERIFY_SENTINEL_READ;
  const fetched = await withBypassRls(
    deps.prisma,
    async (tx) => {
      // The tenant path's precondition, for a bypass: an inert one reads zero
      // rows with no error, exactly as an unset app.tenant_id does. Compared
      // with the grant constant, not a value handed in, so a call made with
      // some other grant fails here.
      const state = await readBypassState(tx);
      if (
        state === null ||
        state.bypassRls !== "on" ||
        state.purpose !== grant.purpose ||
        state.tables !== grant.tables
      ) {
        throw new Error(
          `BYPASS_CONTEXT_MISSING: bypass_rls=${JSON.stringify(state?.bypassRls ?? null)} ` +
            `purpose=${JSON.stringify(state?.purpose ?? null)} tables=${JSON.stringify(state?.tables ?? null)}, ` +
            `expected the AUDIT_CHAIN_VERIFY_SENTINEL_READ grant — reads would be inert or mis-scoped`,
        );
      }
      return readChain(tx, tenantId, true);
    },
    grant,
    TX_BUDGET,
  );
  return resultOf(tenantId, fetched);
}

// ── Worker main loop ─────────────────────────────────────────────

interface TenantState {
  lastAlertAt: number | null;
  inFailedState: boolean;
}

/** Why a tick's tenant list cannot be trusted, keyed by the logged reason. */
const ENUMERATION_FAILURE = {
  TENANT_ENUMERATION_FAILED: "the tenant-list read threw",
  TENANT_ENUMERATION_EMPTY: "the tenant-list read returned no tenants, not even the system tenant",
  TENANT_ENUMERATION_INCOMPLETE:
    "the tenant list did not include the system tenant, which only a full bypass read sees",
} as const;

export async function runTick(
  prisma: PrismaClient,
  states: Map<string, TenantState>,
): Promise<void> {
  const logger = console;
  // `tenants` carries the same tenant_isolation policy as every other table:
  // a bare read sees no rows on a fresh connection and raises 22P02 on one
  // whose app.tenant_id was set and reverted. The enumeration runs under the
  // SYSTEM_MAINTENANCE_TENANT_LOOKUP grant, in its own bypass transaction. A
  // failure here is reported like any other incomplete tick rather than
  // thrown: a throw would skip the heartbeat and leave only the absence alarm,
  // which cannot tell "inert" from "dead".
  let tenants: Array<{ id: string }> = [];
  let enumerationError: unknown = null;
  try {
    tenants = await withBypassRls(
      prisma,
      (tx) => tx.tenant.findMany({ select: { id: true } }),
      BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP,
    );
  } catch (err) {
    enumerationError = err;
  }
  let verified = 0;
  let errored = 0;
  // Tampered/gap tenants. Distinct from `errored`: verification RAN and found a
  // problem, which is CHAIN_VERIFY_FAILED's business, not a coverage shortfall.
  let failed = 0;
  const erroredTenantIds: string[] = [];

  // The `__system__` tenant always exists and is visible only to a full
  // bypass read, so an enumeration without it lost its scope: empty, or scoped
  // to one tenant. That is an error (erroredTenantCount, the field the
  // deployed alert keys on), not a healthy tick; the tenants it did return are
  // still verified.
  //
  // Every tenant is verified, the sentinel included and whatever its
  // audit_chain_enabled: a chain enabled once and then disabled keeps its rows
  // and anchor. verifyTenantChain reads the sentinel under its own bypass grant.
  const sentinel = tenants.find((t) => t.id === SYSTEM_TENANT_ID);
  const verifiable = tenants.map((t) => t.id);
  const enumerationReason: keyof typeof ENUMERATION_FAILURE | null =
    enumerationError !== null
      ? "TENANT_ENUMERATION_FAILED"
      : tenants.length === 0
        ? "TENANT_ENUMERATION_EMPTY"
        : sentinel === undefined
          ? "TENANT_ENUMERATION_INCOMPLETE"
          : null;
  if (enumerationReason !== null) {
    errored++;
    logger.error(
      "audit-chain-verify-worker: tick incomplete — reason=%s (%s) error=%j",
      enumerationReason,
      ENUMERATION_FAILURE[enumerationReason],
      enumerationError !== null ? errorLogFields(enumerationError) : null,
    );
  }
  for (const tenantId of verifiable) {
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
      if (!result.ok) failed++;
      states.set(tenantId, state);
      verified++;
    } catch (err) {
      errored++;
      erroredTenantIds.push(tenantId);
      logger.error(
        "audit-chain-verify-worker: tenant=%s verify threw: %O",
        tenantId,
        err,
      );
    }
  }

  // Liveness and coverage are independent facts and get independent signals.
  //
  // The heartbeat is LIVENESS only, and is emitted unconditionally: its alarm
  // is `absence(...) for 2h`, so withholding it on a tenant failure would make
  // one permanently-failing tenant indistinguishable from a dead worker. That
  // alarm would then fire forever with a recovery step that does nothing, get
  // muted, and a real crash would go unseen — the manufactured-assurance
  // failure this worker exists to avoid, reproduced at the operator.
  //
  // COVERAGE rides on the same line as counts. A partial tick must never read
  // as fully verified, so alert on `verifiedTenantCount < tenantCount` rather
  // than on the heartbeat's absence.
  // Per-tenant failures only; the enumeration reasons above have their own
  // lines.
  if (erroredTenantIds.length > 0) {
    logger.error(
      "audit-chain-verify-worker: tick incomplete — %d/%d tenants failed to verify: %s",
      erroredTenantIds.length,
      verifiable.length,
      // Name them, but bounded: the dominant failure (RLS context lost) fails
      // EVERY tenant, so an unbounded join is a ~10KB line at 283 tenants —
      // past the point a log driver keeps it in one record.
      erroredTenantIds.length > ERRORED_IDS_LOGGED
        ? `${erroredTenantIds.slice(0, ERRORED_IDS_LOGGED).join(",")} (+${erroredTenantIds.length - ERRORED_IDS_LOGGED} more)`
        : erroredTenantIds.join(","),
    );
  }

  console.log(
    JSON.stringify({
      level: "info",
      _logType: "audit-chain-verify-heartbeat",
      tenantCount: verifiable.length,
      verifiedTenantCount: verified,
      erroredTenantCount: errored,
      // Carried here so tamper detection has a structured signal. The only
      // other one is CHAIN_VERIFY_FAILED, a printf stderr line with no
      // _logType that the documented rules cannot match.
      failedTenantCount: failed,
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

  registerBypassNoticeSink(stderrBypassNoticeSink);
  const pool = createPool({ connectionString: databaseUrl });
  const prisma = createPrismaClient(pool);

  const states = new Map<string, TenantState>();
  const stop = { value: false };
  process.on("SIGTERM", () => {
    stop.value = true;
  });
  process.on("SIGINT", () => {
    stop.value = true;
  });

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
