/**
 * POST /api/maintenance/purge-history
 *
 * System-wide purge of password entry history older than retentionDays.
 * Authenticated via ADMIN_API_TOKEN bearer token (not session).
 *
 * Body: { operatorId: string, retentionDays?: number, dryRun?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/parse-body";
import { verifyAdminToken } from "@/lib/auth/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
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
  retentionDays: z.number().int().min(1).max(3650).default(90),
  dryRun: z.boolean().default(false),
});

async function handlePOST(req: NextRequest) {
  // Bearer token auth (checked before rate limit to prevent unauthenticated DoS)
  if (!verifyAdminToken(req)) {
    return unauthorized();
  }

  // Rate limit (global fixed key, applied after auth)
  const rl = await rateLimiter.check("rl:admin:purge-history");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Parse body
  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { operatorId, retentionDays, dryRun } = result.data;

  // Verify operatorId is an active tenant admin
  const op = await requireMaintenanceOperator(operatorId);
  if (!op.ok) return op.response;
  const membership = op.operator;

  // Build where clause (shared between count and delete)
  const cutoffDate = new Date(Date.now() - retentionDays * MS_PER_DAY);
  const whereClause = { changedAt: { lt: cutoffDate } };

  if (dryRun) {
    // Count matching records without deleting
    const matched = await withBypassRls(prisma, async () =>
      prisma.passwordEntryHistory.count({ where: whereClause }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
    return NextResponse.json({ purged: 0, matched, dryRun: true });
  }

  // Delete old history entries across all tenants
  const deleted = await withBypassRls(prisma, async () =>
    prisma.passwordEntryHistory.deleteMany({ where: whereClause }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);

  // Audit log
  await logAuditAsync({
    ...tenantAuditBase(req, SYSTEM_ACTOR_ID, membership.tenantId),
    actorType: ACTOR_TYPE.SYSTEM,
    action: AUDIT_ACTION.HISTORY_PURGE,
    metadata: {
      operatorId,
      [AUDIT_METADATA_KEY.PURGED_COUNT]: deleted.count,
      retentionDays,
      systemWide: true,
    },
  });

  return NextResponse.json({ purged: deleted.count });
}

export const POST = withRequestLog(handlePOST);
