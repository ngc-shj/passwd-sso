/**
 * POST /api/maintenance/purge-audit-logs
 *
 * System-wide purge of audit log entries older than retentionDays.
 * Authenticated via ADMIN_API_TOKEN bearer token (not session).
 *
 * Body: { operatorId: string, retentionDays?: number, dryRun?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/parse-body";
import { verifyAdminToken } from "@/lib/auth/admin-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";
import { AUDIT_METADATA_KEY } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/maintenance-auth";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { MS_PER_DAY } from "@/lib/constants/time";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, unauthorized } from "@/lib/api-response";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const bodySchema = z.object({
  operatorId: z.string().uuid(),
  retentionDays: z.number().int().min(30).max(3650).default(365),
  dryRun: z.boolean().default(false),
});

async function handlePOST(req: NextRequest) {
  if (!verifyAdminToken(req)) {
    return unauthorized();
  }

  const rl = await rateLimiter.check("rl:admin:purge-audit-logs");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { operatorId, retentionDays, dryRun } = result.data;

  const op = await requireMaintenanceOperator(operatorId);
  if (!op.ok) return op.response;
  const membership = op.operator;

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
      const tenantCutoff = new Date(Date.now() - effectiveRetentionDays * MS_PER_DAY);

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
  const totalPurged = perTenantCounts.reduce((a, b) => a + b, 0);

  // AuditLog.tenantId is non-nullable (String, not String?), so no null-tenant handling needed.
  if (dryRun) {
    return NextResponse.json({ purged: 0, matched: totalPurged, dryRun: true });
  }

  await logAuditAsync({
    ...tenantAuditBase(req, SYSTEM_ACTOR_ID, membership.tenantId),
    actorType: ACTOR_TYPE.SYSTEM,
    action: AUDIT_ACTION.HISTORY_PURGE,
    metadata: {
      operatorId,
      [AUDIT_METADATA_KEY.PURGED_COUNT]: totalPurged,
      retentionDays,
      targetTable: "auditLog",
      systemWide: true,
    },
  });

  return NextResponse.json({ purged: totalPurged });
}

export const POST = withRequestLog(handlePOST);
