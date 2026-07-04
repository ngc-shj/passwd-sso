/**
 * POST /api/maintenance/purge-history
 *
 * Tenant-scoped purge of password entry history older than retentionDays.
 * Operates only on rows belonging to the operator-token's bound tenantId;
 * a token issued in tenant A cannot affect tenant B's history.
 * The tenant's own historyRetentionDays floor is respected — and when the
 * tenant has configured NULL (keep forever), the purge is rejected outright
 * rather than falling back to the request-supplied retentionDays (an
 * operator-token holder must not be able to override a tenant's explicit
 * "never delete" policy). Mirrors the audit-log purge floor in purge-audit-logs.
 * Authenticated via per-operator op_* token (mint via /dashboard/tenant/operator-tokens).
 *
 * Body: { retentionDays?: number, dryRun?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/http/parse-body";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { AUDIT_METADATA_KEY } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { MS_PER_DAY } from "@/lib/constants/time";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { withRequestLog } from "@/lib/http/with-request-log";
import { unauthorized, errorResponse } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";

// Rate limiter shares the same key for dryRun and real calls intentionally:
// preventing probe→exploit racing (an admin cannot dry-run-probe matching
// counts then immediately delete within the same 60-second window).
// Fail-closed on Redis error: a destructive maintenance op must not shed its
// throttle during a Redis outage. Keyed per-tenant so one tenant's operator
// cannot 429 another tenant's purge in the same window.
const rateLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: 1,
  failClosedOnRedisError: true,
});

const bodySchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).default(90),
  dryRun: z.boolean().default(false),
});

async function handlePOST(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:maintenance:purge-history:${auth.tenantId}`,
    scope: "maintenance.purge_history",
    userId: auth.subjectUserId,
    tenantId: auth.tenantId,
  });
  if (blocked) return blocked;

  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { retentionDays, dryRun } = result.data;

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  const tenant = await withBypassRls(prisma, async (tx) =>
    tx.tenant.findUnique({
      where: { id: auth.tenantId },
      select: { historyRetentionDays: true },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  // Bound tenant record not found — no-op (purge nothing) rather than falling
  // through to an unfloored delete with the raw request retentionDays. Mirrors
  // purge-audit-logs's "tenant no longer exists" early return; keeps the two
  // routes' retention-floor behavior symmetric even for this unreachable-today
  // edge (Tenant/OperatorToken cascade-delete together, so a valid op_ token
  // cannot outlive its tenant).
  if (!tenant) {
    return NextResponse.json({ purged: 0 });
  }
  // NULL historyRetentionDays means the tenant has explicitly configured
  // "keep forever" — reject rather than silently falling back to the
  // request-supplied retentionDays (an operator-token holder must not be
  // able to override that policy). Mirrors purge-audit-logs.
  if (tenant.historyRetentionDays === null) {
    return errorResponse(API_ERROR.HISTORY_RETENTION_INDEFINITE);
  }
  // Use the stricter (longer) of the requested vs tenant-configured retention.
  const effectiveRetentionDays = tenant.historyRetentionDays
    ? Math.max(retentionDays, tenant.historyRetentionDays)
    : retentionDays;

  const cutoffDate = new Date(Date.now() - effectiveRetentionDays * MS_PER_DAY);
  // Scope deletion to the operator-token's bound tenant. Without this,
  // a tenant-A admin who mints an op_* token can delete history rows in
  // every other tenant via the system-wide where clause.
  const whereClause = {
    tenantId: auth.tenantId,
    changedAt: { lt: cutoffDate },
  };

  if (dryRun) {
    const matched = await withBypassRls(prisma, async (tx) =>
      tx.passwordEntryHistory.count({ where: whereClause }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
    await logAuditAsync({
      ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
      actorType: ACTOR_TYPE.HUMAN,
      action: AUDIT_ACTION.HISTORY_PURGE,
      metadata: {
        tokenSubjectUserId: auth.subjectUserId,
        tokenId: auth.tokenId,
        [AUDIT_METADATA_KEY.PURGED_COUNT]: 0,
        matched,
        retentionDays,
        effectiveRetentionDays,
        scopedTenantId: auth.tenantId,
        dryRun: true,
      },
    });
    return NextResponse.json({ purged: 0, matched, dryRun: true });
  }

  const deleted = await withBypassRls(prisma, async (tx) =>
    tx.passwordEntryHistory.deleteMany({ where: whereClause }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.HISTORY_PURGE,
    metadata: {
      tokenSubjectUserId: auth.subjectUserId,
      tokenId: auth.tokenId,
      [AUDIT_METADATA_KEY.PURGED_COUNT]: deleted.count,
      retentionDays,
      effectiveRetentionDays,
      scopedTenantId: auth.tenantId,
    },
  });

  return NextResponse.json({ purged: deleted.count });
}

export const POST = withRequestLog(handlePOST);
