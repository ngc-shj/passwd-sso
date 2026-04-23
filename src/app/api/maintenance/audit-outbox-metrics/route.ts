/**
 * GET /api/maintenance/audit-outbox-metrics?operatorId=<uuid>
 *
 * Returns global (cross-tenant) outbox aggregates for infrastructure operators.
 * Authenticated via ADMIN_API_TOKEN bearer token (not session).
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
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized } from "@/lib/http/api-response";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 6 });

const querySchema = z.object({
  operatorId: z.string().uuid(),
});

interface MetricsRow {
  pending: bigint;
  processing: bigint;
  failed: bigint;
  oldest_pending_age_seconds: number | null;
  average_attempts_for_sent: number | null;
  dead_letter_count: bigint;
}

async function handleGET(req: NextRequest) {
  if (!verifyAdminToken(req)) {
    return unauthorized();
  }

  const rl = await rateLimiter.check("rl:admin:outbox-metrics");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const params = querySchema.safeParse({
    operatorId: req.nextUrl.searchParams.get("operatorId"),
  });
  if (!params.success) {
    return NextResponse.json(
      { error: "operatorId query parameter (UUID) is required" },
      { status: 400 },
    );
  }

  const { operatorId } = params.data;

  const op = await requireMaintenanceOperator(operatorId);
  if (!op.ok) return op.response;
  const membership = op.operator;

  const rows = await withBypassRls(prisma, async () =>
    prisma.$queryRaw<MetricsRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING')    AS pending,
        COUNT(*) FILTER (WHERE status = 'PROCESSING') AS processing,
        COUNT(*) FILTER (WHERE status = 'FAILED')     AS failed,
        EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status = 'PENDING')))::float
          AS oldest_pending_age_seconds,
        AVG(attempt_count) FILTER (WHERE status = 'SENT')::float
          AS average_attempts_for_sent,
        COUNT(*) FILTER (WHERE status = 'FAILED' AND attempt_count >= max_attempts)
          AS dead_letter_count
      FROM audit_outbox
    `,
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);

  const row = rows[0];
  const metrics = {
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
    failed: Number(row?.failed ?? 0),
    oldestPendingAgeSeconds: row?.oldest_pending_age_seconds ?? 0,
    averageAttemptsForSent: row?.average_attempts_for_sent ?? 0,
    deadLetterCount: Number(row?.dead_letter_count ?? 0),
    asOf: new Date().toISOString(),
  };

  await logAuditAsync({
    ...tenantAuditBase(req, SYSTEM_ACTOR_ID, membership.tenantId),
    actorType: ACTOR_TYPE.SYSTEM,
    action: AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW,
    metadata: { operatorId, pending: metrics.pending, failed: metrics.failed },
  });

  return NextResponse.json(metrics);
}

export const GET = withRequestLog(handleGET);
