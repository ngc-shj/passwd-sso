/**
 * GET /api/maintenance/audit-chain-verify?tenantId=<uuid>&from=<date>&to=<date>
 *
 * Walks the audit hash chain for a tenant and verifies integrity.
 * Detects tampered rows and chain_seq gaps.
 * Authenticated via per-operator op_* token (mint via /dashboard/tenant/operator-tokens).
 *
 * The query `tenantId` is the TARGET tenant being chain-verified. The
 * operator must be admin in that target tenant (their token's tenant binding
 * is independent — multi-tenant operators mint a token per tenant).
 *
 * See docs/security/audit-chain-threat-model.md#retention-purge-interaction:
 * after a retention purge of the earliest chained rows, the default
 * (fromSeq=1) walk below re-seeds from genesis and reports a FALSE TAMPER at
 * the first retained row.
 *
 * The opposite direction — a walk that covers less than the range it was asked
 * to verify reporting ok:true — is closed here: `incomplete` compares how far
 * the walk actually got against toSeq unconditionally, and a missing anchor is
 * only benign when no chained row survives. Purge-aware verification (telling
 * a legitimate retention purge apart from row deletion) needs the deferred
 * purged_up_to_seq watermark; until it lands, both answer RANGE_INCOMPLETE.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, unauthorized, forbidden } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseQuery } from "@/lib/http/parse-body";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit/audit-chain";
import { MS_PER_DAY } from "@/lib/constants/time";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

// Fail-closed on Redis error; the tenant-scoped key uses the operator-token's
// bound tenant (auth.tenantId), not the caller-supplied query param.
const rateLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: 3,
  failClosedOnRedisError: true,
});

const FIVE_YEARS_MS = 5 * 365 * MS_PER_DAY;
const MAX_ROWS_PER_REQUEST = 10_000;

function buildQuerySchema() {
  const now = new Date();
  return z
    .object({
      tenantId: z.string().uuid(),
      from: z.coerce
        .date()
        .min(new Date(now.getTime() - FIVE_YEARS_MS), { message: "from is too far in the past" })
        .optional(),
      to: z.coerce.date().max(now, { message: "to must not be in the future" }).optional(),
    })
    .refine(
      (data) => {
        if (data.from && data.to) return data.from < data.to;
        return true;
      },
      { message: "from must be before to" },
    );
}

interface ChainRowRaw {
  id: string;
  created_at: Date;
  chain_seq: string;
  event_hash: Uint8Array;
  chain_prev_hash: Uint8Array;
  metadata: unknown;
}

interface ChainRow {
  id: string;
  created_at: Date;
  chain_seq: string;
  event_hash: Buffer;
  chain_prev_hash: Buffer;
  metadata: unknown;
}

function toChainRow(raw: ChainRowRaw): ChainRow {
  return {
    ...raw,
    event_hash: Buffer.from(raw.event_hash),
    chain_prev_hash: Buffer.from(raw.chain_prev_hash),
  };
}

interface AnchorRow {
  chain_seq: string;
}

interface SeqBoundRow {
  chain_seq: string | null;
}

async function handleGET(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:maintenance:chain-verify:${auth.tenantId}`,
    scope: "maintenance.chain_verify",
    userId: auth.subjectUserId,
    tenantId: auth.tenantId,
  });
  if (blocked) return blocked;

  const querySchema = buildQuerySchema();
  const result = parseQuery(req, querySchema);
  if (!result.ok) return result.response;
  const { tenantId, from, to } = result.data;

  // Operator-token boundary: a token is bound to a single tenant. Reject
  // cross-tenant chain-verify requests; multi-tenant operators must mint
  // a separate token per tenant they need to verify.
  if (auth.tenantId !== tenantId) {
    return forbidden();
  }

  // Operator must be admin in the (token's) target tenant being verified
  const op = await requireMaintenanceOperator(auth.subjectUserId, { tenantId });
  if (!op.ok) return op.response;
  const membership = op.operator;

  // Read the anchor row to get the snapshot upper bound
  const anchors = await withBypassRls(
    prisma,
    async (tx) =>
      tx.$queryRawUnsafe<AnchorRow[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1`,
        tenantId,
      ),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
  );

  if (!anchors.length) {
    // No anchor is only benign when the tenant has no chained rows at all.
    // An anchor that vanished while chained rows survive is indistinguishable
    // from "never anchored" on the anchor read alone, and answering ok:true
    // there would report VALID having verified nothing.
    const chainedRows = await withBypassRls(
      prisma,
      async (tx) =>
        tx.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT COUNT(*) AS count
           FROM audit_logs
           WHERE tenant_id = $1
             AND chain_seq IS NOT NULL`,
          tenantId,
        ),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
    if (Number(chainedRows[0]?.count ?? 0) > 0) {
      await logAuditAsync({
        ...tenantAuditBase(req, auth.subjectUserId, membership.tenantId),
        actorType: ACTOR_TYPE.HUMAN,
        action: AUDIT_ACTION.AUDIT_CHAIN_VERIFY,
        metadata: {
          tokenSubjectUserId: auth.subjectUserId,
          tokenId: auth.tokenId,
          targetTenantId: tenantId,
          ok: false,
          reason: "ANCHOR_MISSING",
          totalVerified: 0,
        },
      });
      return NextResponse.json({
        ok: false,
        reason: "ANCHOR_MISSING",
        truncated: false,
        walkedThrough: 0,
        firstTamperedSeq: null,
        firstGapAfterSeq: null,
        firstTimestampViolationSeq: null,
        totalVerified: 0,
      });
    }
    return NextResponse.json({ ok: true, totalVerified: 0 });
  }

  const anchorSeq = Number(anchors[0].chain_seq);

  // Determine the from_seq boundary
  let fromSeq = 1;
  if (from) {
    const fromRows = await withBypassRls(
      prisma,
      async (tx) =>
        tx.$queryRawUnsafe<SeqBoundRow[]>(
          `SELECT MIN(chain_seq) AS chain_seq
           FROM audit_logs
           WHERE tenant_id = $1
             AND chain_seq IS NOT NULL
             AND created_at >= $2`,
          tenantId,
          from,
        ),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
    const minSeq = fromRows[0]?.chain_seq;
    if (minSeq != null) {
      fromSeq = Number(minSeq);
    }
  }

  // Determine the to_seq boundary
  let toSeq = anchorSeq;
  if (to) {
    const toRows = await withBypassRls(
      prisma,
      async (tx) =>
        tx.$queryRawUnsafe<SeqBoundRow[]>(
          `SELECT MAX(chain_seq) AS chain_seq
           FROM audit_logs
           WHERE tenant_id = $1
             AND chain_seq IS NOT NULL
             AND created_at <= $2`,
          tenantId,
          to,
        ),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
    const maxSeq = toRows[0]?.chain_seq;
    if (maxSeq != null) {
      toSeq = Math.min(toSeq, Number(maxSeq));
    }
  }

  // Load the prevHash seed for partial walks (fromSeq > 1 needs the hash from seq - 1)
  let seedPrevHash: Buffer = Buffer.from([0x00]);
  if (fromSeq > 1) {
    const seedRows = await withBypassRls(
      prisma,
      async (tx) =>
        tx.$queryRawUnsafe<{ event_hash: Uint8Array }[]>(
          `SELECT event_hash
           FROM audit_logs
           WHERE tenant_id = $1
             AND chain_seq = $2`,
          tenantId,
          BigInt(fromSeq - 1),
        ),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    );
    if (!seedRows[0]?.event_hash) {
      return errorResponse(API_ERROR.AUDIT_CHAIN_SEED_NOT_FOUND);
    }
    seedPrevHash = Buffer.from(seedRows[0].event_hash);
  }

  // Walk the chain
  let totalVerified = 0;
  let firstTamperedSeq: number | null = null;
  let firstGapAfterSeq: number | null = null;
  let firstTimestampViolationSeq: number | null = null;
  let prevHash = seedPrevHash;
  let prevSeq: number | null = null;
  let prevCreatedAt: Date | null = null;

  const rows = await withBypassRls(
    prisma,
    async (tx) =>
      tx.$queryRawUnsafe<ChainRowRaw[]>(
        `SELECT id, tenant_id, created_at,
                chain_seq, event_hash, chain_prev_hash, metadata
         FROM audit_logs
         WHERE tenant_id = $1
           AND chain_seq IS NOT NULL
           AND chain_seq >= $2
           AND chain_seq <= $3
         ORDER BY chain_seq ASC
         LIMIT $4`,
        tenantId,
        BigInt(fromSeq),
        BigInt(toSeq),
        MAX_ROWS_PER_REQUEST,
      ).then((rawRows) => rawRows.map(toChainRow)),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
  );

  // C15 (OWASP A08-2): bail at first tamper. Continuing the walk after
  // tamper using the stored (tampered) hash produces meaningless
  // verification results for subsequent rows — the operator should treat
  // them as unverified. walkedThrough captures the count of rows verified
  // BEFORE bailing; rows beyond that point are not re-hashed.
  let walkedThrough = 0;
  for (const row of rows) {
    const seq = Number(row.chain_seq);

    // Check for gaps in chain_seq (informational only, doesn't bail)
    if (prevSeq !== null && firstGapAfterSeq === null) {
      if (seq !== prevSeq + 1) {
        firstGapAfterSeq = prevSeq;
      }
    }

    if (prevCreatedAt !== null && row.created_at < prevCreatedAt && firstTimestampViolationSeq === null) {
      firstTimestampViolationSeq = seq;
    }

    // Re-compute the event hash and compare with stored event_hash
    const payload =
      row.metadata != null && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};

    const chainInput = buildChainInput({
      id: row.id,
      createdAt: row.created_at,
      chainSeq: BigInt(row.chain_seq),
      prevHash,
      payload,
    });
    const canonicalBytes = computeCanonicalBytes(chainInput);
    const computedHash = computeEventHash(prevHash, canonicalBytes);

    if (!computedHash.equals(row.event_hash)) {
      firstTamperedSeq = seq;
      // Bail — subsequent rows are unverified.
      break;
    }

    prevHash = row.event_hash;
    prevSeq = seq;
    prevCreatedAt = row.created_at;
    totalVerified++;
    walkedThrough++;
  }

  // How far up the requested range the walk actually got. With no rows walked,
  // nothing above the lower bound is covered.
  const coveredUpToSeq = prevSeq !== null ? prevSeq : fromSeq - 1;
  // Anything short of toSeq means the walk did not verify what it was asked to.
  // Hitting the row cap is one cause; rows deleted or purged out of the range
  // (which leave no gap BETWEEN the returned rows, so integrityOk stays true)
  // are others, and they reach here without the cap being involved.
  const incomplete = fromSeq > toSeq || coveredUpToSeq < toSeq;
  // Kept as a distinct signal so an operator can tell "ask for a smaller range"
  // apart from "the range is missing rows".
  const truncated = rows.length >= MAX_ROWS_PER_REQUEST && incomplete;
  const verifiedUpToSeq = prevSeq !== null ? prevSeq : undefined;

  const integrityOk = firstTamperedSeq === null && firstGapAfterSeq === null && firstTimestampViolationSeq === null;
  // Fail-closed: a walk that did not cover the requested range is never ok,
  // whatever stopped it.
  const ok = integrityOk && !incomplete;

  // Machine-readable failure reason. Integrity violations outrank coverage
  // shortfalls — a tamper bails the walk, which also leaves it incomplete.
  let reason:
    | "TRUNCATED"
    | "TAMPER_DETECTED"
    | "GAP_DETECTED"
    | "TIMESTAMP_VIOLATION"
    | "RANGE_INCOMPLETE"
    | undefined;
  if (!ok) {
    if (firstTamperedSeq !== null) {
      reason = "TAMPER_DETECTED";
    } else if (firstGapAfterSeq !== null) {
      reason = "GAP_DETECTED";
    } else if (firstTimestampViolationSeq !== null) {
      reason = "TIMESTAMP_VIOLATION";
    } else if (truncated) {
      reason = "TRUNCATED";
    } else {
      reason = "RANGE_INCOMPLETE";
    }
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, membership.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.AUDIT_CHAIN_VERIFY,
    metadata: {
      tokenSubjectUserId: auth.subjectUserId,
      tokenId: auth.tokenId,
      targetTenantId: tenantId,
      ok,
      reason,
      totalVerified,
      truncated,
      verifiedUpToSeq,
      firstTamperedSeq,
      firstGapAfterSeq,
      firstTimestampViolationSeq,
    },
  });

  return NextResponse.json({
    ok,
    truncated,
    walkedThrough,
    ...(reason ? { reason } : {}),
    ...(verifiedUpToSeq !== undefined ? { verifiedUpToSeq } : {}),
    firstTamperedSeq,
    firstGapAfterSeq,
    firstTimestampViolationSeq,
    totalVerified,
  });
}

export const GET = withRequestLog(handleGET);
