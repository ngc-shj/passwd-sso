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
import { verifyAdminToken } from "@/lib/admin-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";
import { AUDIT_METADATA_KEY } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
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

  const membership = await withBypassRls(prisma, async () =>
    prisma.tenantMember.findFirst({
      where: {
        userId: operatorId,
        role: { in: ["OWNER", "ADMIN"] },
        deactivatedAt: null,
      },
      select: {
        tenantId: true,
        role: true,
      },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  if (!membership) {
    return NextResponse.json(
      { error: "operatorId is not an active tenant admin" },
      { status: 400 },
    );
  }

  const tenants = await withBypassRls(prisma, async () =>
    prisma.tenant.findMany({
      select: { id: true, auditLogRetentionDays: true },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);

  let totalPurged = 0;

  // Per-tenant purge: each tenant's floor retention is respected
  for (const tenant of tenants) {
    const tenantRetention = tenant.auditLogRetentionDays;
    // Use the stricter (longer) of the requested vs tenant-configured retention
    const effectiveRetentionDays = tenantRetention
      ? Math.max(retentionDays, tenantRetention)
      : retentionDays;
    const tenantCutoff = new Date(Date.now() - effectiveRetentionDays * 24 * 60 * 60 * 1000);

    if (dryRun) {
      const count = await withBypassRls(prisma, async () =>
        prisma.auditLog.count({
          where: { tenantId: tenant.id, createdAt: { lt: tenantCutoff } },
        }),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
      totalPurged += count;
    } else {
      const result = await withBypassRls(prisma, async () =>
        prisma.auditLog.deleteMany({
          where: { tenantId: tenant.id, createdAt: { lt: tenantCutoff } },
        }),
      BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
      totalPurged += result.count;
    }
  }

  // AuditLog.tenantId is non-nullable (String, not String?), so no null-tenant handling needed.
  if (dryRun) {
    return NextResponse.json({ purged: 0, matched: totalPurged, dryRun: true });
  }

  const { ip, userAgent } = extractRequestMeta(req);
  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.HISTORY_PURGE,
    userId: SYSTEM_ACTOR_ID,
    actorType: ACTOR_TYPE.SYSTEM,
    tenantId: membership.tenantId,
    metadata: {
      operatorId,
      [AUDIT_METADATA_KEY.PURGED_COUNT]: totalPurged,
      retentionDays,
      targetTable: "auditLog",
      systemWide: true,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({ purged: totalPurged });
}

export const POST = withRequestLog(handlePOST);
