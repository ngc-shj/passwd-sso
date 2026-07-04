/**
 * GET /api/maintenance/audit-outbox-metrics
 *
 * Returns outbox aggregates scoped to the operator-token's bound tenantId.
 * Cross-tenant aggregates are intentionally not exposed: a tenant admin's
 * token must not reveal queue depth, failure counts, or oldest-pending age
 * for another tenant. Multi-tenant operators mint a token per tenant.
 * Authenticated via per-operator op_* token (mint via /dashboard/tenant/operator-tokens).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { unauthorized } from "@/lib/http/api-response";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

// Keyed per-tenant so one tenant's operator cannot exhaust another tenant's
// metrics quota in the same window; fail-closed on Redis error.
const rateLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: 6,
  failClosedOnRedisError: true,
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
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:maintenance:outbox-metrics:${auth.tenantId}`,
    scope: "maintenance.outbox_metrics",
    userId: auth.subjectUserId,
    tenantId: auth.tenantId,
  });
  if (blocked) return blocked;

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  // Scope aggregates to the operator-token's bound tenant. Without the
  // WHERE filter, queue depth and failure counts of every other tenant
  // leak through this endpoint.
  const rows = await withBypassRls(prisma, async (tx) =>
    tx.$queryRaw<MetricsRow[]>`
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
      WHERE tenant_id = ${auth.tenantId}::uuid
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
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW,
    metadata: {
      tokenSubjectUserId: auth.subjectUserId,
      tokenId: auth.tokenId,
      scopedTenantId: auth.tenantId,
      pending: metrics.pending,
      failed: metrics.failed,
    },
  });

  return NextResponse.json(metrics);
}

export const GET = withRequestLog(handleGET);
