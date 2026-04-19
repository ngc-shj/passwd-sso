/**
 * POST /api/maintenance/dcr-cleanup
 *
 * Delete expired unclaimed DCR clients (isDcr=true, tenantId=null, dcrExpiresAt < now).
 * Authenticated via ADMIN_API_TOKEN bearer token (not session).
 *
 * Body: { operatorId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/parse-body";
import { verifyAdminToken } from "@/lib/admin-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";
import { AUDIT_METADATA_KEY } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/maintenance-auth";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, unauthorized } from "@/lib/api-response";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const bodySchema = z.object({
  operatorId: z.string().uuid(),
});

async function handlePOST(req: NextRequest) {
  // Bearer token auth (checked before rate limit to prevent unauthenticated DoS)
  if (!verifyAdminToken(req)) {
    return unauthorized();
  }

  // Rate limit (global fixed key, applied after auth)
  const rl = await rateLimiter.check("rl:admin:dcr-cleanup");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Parse body
  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { operatorId } = result.data;

  // Verify operatorId is an active tenant admin
  const op = await requireMaintenanceOperator(operatorId);
  if (!op.ok) return op.response;
  const membership = op.operator;

  // Delete expired unclaimed DCR clients
  const deleted = await withBypassRls(prisma, async () =>
    prisma.mcpClient.deleteMany({
      where: {
        isDcr: true,
        tenantId: null,
        dcrExpiresAt: { lt: new Date() },
      },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);

  // Audit log
  await logAuditAsync({
    ...tenantAuditBase(req, SYSTEM_ACTOR_ID, membership.tenantId),
    actorType: ACTOR_TYPE.SYSTEM,
    action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP,
    metadata: {
      operatorId,
      [AUDIT_METADATA_KEY.PURGED_COUNT]: deleted.count,
      systemWide: true,
    },
  });

  return NextResponse.json({ deleted: deleted.count });
}

export const POST = withRequestLog(handlePOST);
