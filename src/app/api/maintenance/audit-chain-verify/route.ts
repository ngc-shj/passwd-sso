/**
 * GET /api/maintenance/audit-chain-verify?tenantId=<uuid>&operatorId=<uuid>&from=<date>&to=<date>
 *
 * Walks the audit hash chain for a tenant and verifies integrity.
 * Detects tampered rows and chain_seq gaps.
 * Authenticated via ADMIN_API_TOKEN bearer token (not session).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyAdminToken } from "@/lib/admin-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, unauthorized } from "@/lib/api-response";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit-chain";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 3 });

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const MAX_ROWS_PER_REQUEST = 10_000;

function buildQuerySchema() {
  const now = new Date();
  return z
    .object({
      tenantId: z.string().uuid(),
      operatorId: z.string().uuid(),
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

// Prisma $queryRawUnsafe returns bigint as string, bytea as Uint8Array
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
  if (!verifyAdminToken(req)) {
    return unauthorized();
  }

  const tenantIdParam = req.nextUrl.searchParams.get("tenantId") ?? "global";
  const rl = await rateLimiter.check(`rl:admin:chain-verify:${tenantIdParam}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const querySchema = buildQuerySchema();
  const params = querySchema.safeParse({
    tenantId: req.nextUrl.searchParams.get("tenantId"),
    operatorId: req.nextUrl.searchParams.get("operatorId"),
    from: req.nextUrl.searchParams.get("from") ?? undefined,
    to: req.nextUrl.searchParams.get("to") ?? undefined,
  });
  if (!params.success) {
    return NextResponse.json(
      { error: params.error.issues[0]?.message ?? "Invalid query parameters" },
      { status: 400 },
    );
  }

  const { tenantId, operatorId, from, to } = params.data;

  const membership = await withBypassRls(
    prisma,
    async () =>
      prisma.tenantMember.findFirst({
        where: {
          userId: operatorId,
          tenantId,
          role: { in: ["OWNER", "ADMIN"] },
          deactivatedAt: null,
        },
        select: { tenantId: true },
      }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
  );
  if (!membership) {
    return NextResponse.json(
      { error: "operatorId is not an active tenant admin" },
      { status: 400 },
    );
  }

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

  const ok = firstTamperedSeq === null && firstGapAfterSeq === null && firstTimestampViolationSeq === null;

  const { ip, userAgent } = extractRequestMeta(req);
  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.AUDIT_CHAIN_VERIFY,
    userId: operatorId,
    tenantId: membership.tenantId,
    metadata: {
      targetTenantId: tenantId,
      ok,
      totalVerified,
      firstTamperedSeq,
      firstGapAfterSeq,
      firstTimestampViolationSeq,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({
    ok,
    firstTamperedSeq,
    firstGapAfterSeq,
    firstTimestampViolationSeq,
    totalVerified,
  });
}

export const GET = withRequestLog(handleGET);
