/**
 * POST /api/maintenance/dcr-cleanup
 *
 * Delete expired unclaimed DCR clients (isDcr=true, tenantId=null, dcrExpiresAt < now).
 * Authenticated via per-operator op_* token (mint via /dashboard/tenant/operator-tokens).
 *
 * Body: {} (empty — token carries the operator identity)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { AUDIT_METADATA_KEY } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized } from "@/lib/http/api-response";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

async function handlePOST(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const rl = await rateLimiter.check("rl:admin:dcr-cleanup");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  // Delete expired unclaimed DCR clients
  const deleted = await withBypassRls(
    prisma,
    async () =>
      prisma.mcpClient.deleteMany({
        where: {
          isDcr: true,
          tenantId: null,
          dcrExpiresAt: { lt: new Date() },
        },
      }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
  );

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP,
    metadata: {
      tokenSubjectUserId: auth.subjectUserId,
      tokenId: auth.tokenId,
      [AUDIT_METADATA_KEY.PURGED_COUNT]: deleted.count,
      systemWide: true,
    },
  });

  return NextResponse.json({ deleted: deleted.count });
}

export const POST = withRequestLog(handlePOST);
