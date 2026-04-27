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
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized } from "@/lib/http/api-response";
import { parseQuery } from "@/lib/http/parse-body";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit/audit-chain";
import { MS_PER_DAY } from "@/lib/constants/time";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 3 });

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

  const tenantIdParam = req.nextUrl.searchParams.get("tenantId") ?? "global";
  const rl = await rateLimiter.check(`rl:admin:chain-verify:${tenantIdParam}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const querySchema = buildQuerySchema();
  const result = parseQuery(req, querySchema);
  if (!result.ok) return result.response;
  const { tenantId, from, to } = result.data;

  // Operator must be admin in the target tenant being verified
  const op = await requireMaintenanceOperator(auth.subjectUserId, { tenantId });
  if (!op.ok) return op.response;
  const membership = op.operator;

  // Read the anchor row to get the snapshot upper bound
  const anchors = await withBypassRls(
    prisma,
    async () =>
      prisma.$queryRawUnsafe<AnchorRow[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1`,
        tenantId,
      ),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
  );

  if (!anchors.length) {
    return NextResponse.json({ ok: true, totalVerified: 0 });
  }

  const anchorSeq = Number(anchors[0].chain_seq);

  // Determine the from_seq boundary
  let fromSeq = 1;
  if (from) {
    const fromRows = await withBypassRls(
      prisma,
      async () =>
        prisma.$queryRawUnsafe<SeqBoundRow[]>(
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
      async () =>
        prisma.$queryRawUnsafe<SeqBoundRow[]>(
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
      async () =>
        prisma.$queryRawUnsafe<{ event_hash: Uint8Array }[]>(
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
      return NextResponse.json(
        { error: `Seed row for chain_seq ${fromSeq - 1} not found — partial verification requires the preceding row` },
        { status: 422 },
      );
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
    async () =>
      prisma.$queryRawUnsafe<ChainRowRaw[]>(
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

  for (const row of rows) {
    const seq = Number(row.chain_seq);

    // Check for gaps in chain_seq
    if (prevSeq !== null && firstGapAfterSeq === null) {
      if (seq !== prevSeq + 1) {
        firstGapAfterSeq = prevSeq;
      }
    }

    if (prevCreatedAt !== null && row.created_at < prevCreatedAt && firstTimestampViolationSeq === null) {
      firstTimestampViolationSeq = seq;
    }

    // Re-compute the event hash and compare with stored event_hash
    if (firstTamperedSeq === null) {
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
      }
    }

    prevHash = row.event_hash;
    prevSeq = seq;
    prevCreatedAt = row.created_at;
    totalVerified++;
  }

  // Detect truncation: query hit MAX_ROWS_PER_REQUEST before covering full range
  const truncated = rows.length >= MAX_ROWS_PER_REQUEST && (prevSeq === null || prevSeq < toSeq);
  const verifiedUpToSeq = prevSeq !== null ? prevSeq : undefined;

  const integrityOk = firstTamperedSeq === null && firstGapAfterSeq === null && firstTimestampViolationSeq === null;
  // Fail-closed: truncated verification is never reported as ok
  const ok = integrityOk && !truncated;

  // Machine-readable failure reason
  let reason: "TRUNCATED" | "TAMPER_DETECTED" | "GAP_DETECTED" | "TIMESTAMP_VIOLATION" | undefined;
  if (!ok) {
    if (truncated && integrityOk) {
      reason = "TRUNCATED";
    } else if (firstTamperedSeq !== null) {
      reason = "TAMPER_DETECTED";
    } else if (firstGapAfterSeq !== null) {
      reason = "GAP_DETECTED";
    } else if (firstTimestampViolationSeq !== null) {
      reason = "TIMESTAMP_VIOLATION";
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
    ...(reason ? { reason } : {}),
    ...(verifiedUpToSeq !== undefined ? { verifiedUpToSeq } : {}),
    firstTamperedSeq,
    firstGapAfterSeq,
    firstTimestampViolationSeq,
    totalVerified,
  });
}

export const GET = withRequestLog(handleGET);
