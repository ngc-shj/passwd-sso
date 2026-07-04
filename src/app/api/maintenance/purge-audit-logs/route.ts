/**
 * POST /api/maintenance/purge-audit-logs
 *
 * Tenant-scoped purge of audit log entries older than retentionDays.
 * Operates only on rows belonging to the operator-token's bound tenantId;
 * a token issued in tenant A cannot erase audit evidence in tenant B.
 * The tenant's own auditLogRetentionDays floor is still respected — and when
 * the tenant has configured NULL (keep forever), the purge is rejected
 * outright rather than falling back to the request-supplied retentionDays
 * (an operator-token holder must not be able to override a tenant's
 * explicit "never delete" policy).
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
import { applyRetentionFloor } from "@/lib/maintenance/retention-floor";

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
  retentionDays: z.number().int().min(30).max(3650).default(365),
  dryRun: z.boolean().default(false),
});

type PurgeResult =
  | { ok: true; purged: number }
  | { ok: false; reason: "RETENTION_INDEFINITE" };

async function purgeForTenant(
  tenantId: string,
  retentionDays: number,
  dryRun: boolean,
): Promise<PurgeResult> {
  const tenant = await withBypassRls(prisma, async (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { auditLogRetentionDays: true },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  if (!tenant) {
    return { ok: true, purged: 0 };
  }

  // NULL auditLogRetentionDays means the tenant has explicitly configured
  // "keep forever" — reject rather than silently falling back to the
  // request-supplied retentionDays (an operator-token holder must not be
  // able to override that policy). Shared floor logic; see retention-floor.ts.
  const floor = applyRetentionFloor(retentionDays, tenant.auditLogRetentionDays);
  if (!floor.ok) {
    return { ok: false, reason: "RETENTION_INDEFINITE" };
  }
  const effectiveRetentionDays = floor.effectiveRetentionDays;
  const tenantCutoff = new Date(
    Date.now() - effectiveRetentionDays * MS_PER_DAY,
  );

  if (dryRun) {
    const matched = await withBypassRls(prisma, async (tx) =>
      tx.auditLog.count({
        where: { tenantId, createdAt: { lt: tenantCutoff } },
      }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
    return { ok: true, purged: matched };
  }
  // C13: audit_logs DELETE is revoked from passwd_app; route through the
  // SECURITY DEFINER function so retention purges (legitimate operation)
  // still work while rogue UPDATE/DELETE attempts via app-role SQL fail.
  const rows = await withBypassRls(prisma, async (tx) =>
    tx.$queryRaw<Array<{ rows_deleted: number }>>`
      SELECT audit_log_purge(${tenantId}::uuid, ${tenantCutoff}::timestamptz) AS rows_deleted
    `,
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  return { ok: true, purged: rows[0]?.rows_deleted ?? 0 };
}

async function handlePOST(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:maintenance:purge-audit-logs:${auth.tenantId}`,
    scope: "maintenance.purge_audit_logs",
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

  // Scope purge to the operator-token's bound tenant. Without this,
  // a tenant-A admin who mints an op_* token can erase audit evidence
  // in every other tenant — a cross-tenant anti-forensics vector.
  const purgeResult = await purgeForTenant(auth.tenantId, retentionDays, dryRun);

  if (!purgeResult.ok) {
    // Tenant has auditLogRetentionDays = NULL (keep forever) — reject
    // outright rather than falling back to the request-supplied retentionDays.
    return errorResponse(API_ERROR.AUDIT_LOG_RETENTION_INDEFINITE);
  }
  const totalPurged = purgeResult.purged;

  if (dryRun) {
    await logAuditAsync({
      ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
      actorType: ACTOR_TYPE.HUMAN,
      action: AUDIT_ACTION.AUDIT_LOG_PURGE,
      metadata: {
        tokenSubjectUserId: auth.subjectUserId,
        tokenId: auth.tokenId,
        [AUDIT_METADATA_KEY.PURGED_COUNT]: 0,
        matched: totalPurged,
        retentionDays,
        targetTable: "auditLog",
        scopedTenantId: auth.tenantId,
        dryRun: true,
      },
    });
    return NextResponse.json({ purged: 0, matched: totalPurged, dryRun: true });
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.AUDIT_LOG_PURGE,
    metadata: {
      tokenSubjectUserId: auth.subjectUserId,
      tokenId: auth.tokenId,
      [AUDIT_METADATA_KEY.PURGED_COUNT]: totalPurged,
      retentionDays,
      targetTable: "auditLog",
      scopedTenantId: auth.tenantId,
    },
  });

  return NextResponse.json({ purged: totalPurged });
}

export const POST = withRequestLog(handlePOST);
