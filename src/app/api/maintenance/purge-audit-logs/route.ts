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
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";
import { AUDIT_METADATA_KEY } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, unauthorized } from "@/lib/api-response";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const bodySchema = z.object({
  operatorId: z.string().uuid(),
  retentionDays: z.number().int().min(30).max(3650).default(365),
  dryRun: z.boolean().default(false),
});

async function handlePOST(req: NextRequest) {
  // Bearer token auth (checked before rate limit to prevent unauthenticated DoS)
  if (!verifyAdminToken(req)) {
    return unauthorized();
  }

  // Rate limit (global fixed key, applied after auth)
  const rl = await rateLimiter.check("rl:admin:purge-audit-logs");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Parse body
  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { operatorId, retentionDays, dryRun } = result.data;

  // Verify operatorId is an active tenant admin
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
        tenant: { select: { auditLogRetentionDays: true } },
      },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  if (!membership) {
    return NextResponse.json(
      { error: "operatorId is not an active tenant admin" },
      { status: 400 },
    );
  }

  // Enforce tenant minimum retention policy
  const tenantRetentionDays = membership.tenant?.auditLogRetentionDays ?? null;
  if (tenantRetentionDays !== null && retentionDays < tenantRetentionDays) {
    return NextResponse.json(
      {
        error: `retentionDays (${retentionDays}) is less than the tenant minimum retention policy (${tenantRetentionDays})`,
      },
      { status: 400 },
    );
  }

  // Build where clause (shared between count and delete)
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const whereClause = { createdAt: { lt: cutoffDate } };

  if (dryRun) {
    // Count matching records without deleting
    const matched = await withBypassRls(prisma, async () =>
      prisma.auditLog.count({ where: whereClause }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
    return NextResponse.json({ purged: 0, matched, dryRun: true });
  }

  // Delete old audit log entries across all tenants
  const deleted = await withBypassRls(prisma, async () =>
    prisma.auditLog.deleteMany({ where: whereClause }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);

  // Audit log
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.HISTORY_PURGE,
    userId: operatorId,
    tenantId: membership.tenantId,
    metadata: {
      [AUDIT_METADATA_KEY.PURGED_COUNT]: deleted.count,
      retentionDays,
      targetTable: "auditLog",
      systemWide: true,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({ purged: deleted.count });
}

export const POST = withRequestLog(handlePOST);
