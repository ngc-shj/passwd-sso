/**
 * POST /api/maintenance/purge-audit-logs
 *
 * System-wide purge of audit log entries older than retentionDays.
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
  retentionDays: z.number().int().min(30).max(3650).default(365),
  dryRun: z.boolean().default(false),
});

async function purgeAcrossTenants(
  retentionDays: number,
  dryRun: boolean,
): Promise<number> {
  const tenants = await withBypassRls(prisma, async () =>
    prisma.tenant.findMany({
      select: { id: true, auditLogRetentionDays: true },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);

  // Per-tenant purge (parallel): each tenant's floor retention is respected
  const perTenantCounts = await Promise.all(
    tenants.map(async (tenant) => {
      const tenantRetention = tenant.auditLogRetentionDays;
      // Use the stricter (longer) of the requested vs tenant-configured retention
      const effectiveRetentionDays = tenantRetention
        ? Math.max(retentionDays, tenantRetention)
        : retentionDays;
      const tenantCutoff = new Date(
        Date.now() - effectiveRetentionDays * MS_PER_DAY,
      );

      if (dryRun) {
        return withBypassRls(prisma, async () =>
          prisma.auditLog.count({
            where: { tenantId: tenant.id, createdAt: { lt: tenantCutoff } },
          }),
        BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
      }
      const result = await withBypassRls(prisma, async () =>
        prisma.auditLog.deleteMany({
          where: { tenantId: tenant.id, createdAt: { lt: tenantCutoff } },
        }),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
      return result.count;
    }),
  );
  return perTenantCounts.reduce((a, b) => a + b, 0);
}

async function handlePOST(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const rl = await rateLimiter.check("rl:admin:purge-audit-logs");
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

  const totalPurged = await purgeAcrossTenants(retentionDays, dryRun);

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
        systemWide: true,
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
      systemWide: true,
    },
  });

  return NextResponse.json({ purged: totalPurged });
}

export const POST = withRequestLog(handlePOST);
