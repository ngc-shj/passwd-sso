/**
 * POST /api/maintenance/purge-history
 *
 * Tenant-scoped purge of password entry history older than retentionDays.
 * Operates only on rows belonging to the operator-token's bound tenantId;
 * a token issued in tenant A cannot affect tenant B's history.
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
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { AUDIT_METADATA_KEY } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { MS_PER_DAY } from "@/lib/constants/time";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized } from "@/lib/http/api-response";

// Rate limiter shares the same key for dryRun and real calls intentionally:
// preventing probe→exploit racing (an admin cannot dry-run-probe matching
// counts then immediately delete within the same 60-second window).
const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

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

  const rl = await rateLimiter.check("rl:admin:purge-history");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { retentionDays, dryRun } = result.data;

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  const cutoffDate = new Date(Date.now() - retentionDays * MS_PER_DAY);
  // Scope deletion to the operator-token's bound tenant. Without this,
  // a tenant-A admin who mints an op_* token can delete history rows in
  // every other tenant via the system-wide where clause.
  const whereClause = {
    tenantId: auth.tenantId,
    changedAt: { lt: cutoffDate },
  };

  if (dryRun) {
    const matched = await withBypassRls(prisma, async () =>
      prisma.passwordEntryHistory.count({ where: whereClause }),
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
        scopedTenantId: auth.tenantId,
        dryRun: true,
      },
    });
    return NextResponse.json({ purged: 0, matched, dryRun: true });
  }

  const deleted = await withBypassRls(prisma, async () =>
    prisma.passwordEntryHistory.deleteMany({ where: whereClause }),
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
      scopedTenantId: auth.tenantId,
    },
  });

  return NextResponse.json({ purged: deleted.count });
}

export const POST = withRequestLog(handlePOST);
