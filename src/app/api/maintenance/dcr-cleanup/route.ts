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
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";
import { AUDIT_METADATA_KEY } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
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
  const membership = await withBypassRls(prisma, async () =>
    prisma.tenantMember.findFirst({
      where: {
        userId: operatorId,
        role: { in: ["OWNER", "ADMIN"] },
        deactivatedAt: null,
      },
      select: { tenantId: true, role: true },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  if (!membership) {
    return NextResponse.json(
      { error: "operatorId is not an active tenant admin" },
      { status: 400 },
    );
  }

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
  const { ip, userAgent } = extractRequestMeta(req);
  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP,
    userId: operatorId,
    tenantId: membership.tenantId,
    metadata: {
      [AUDIT_METADATA_KEY.PURGED_COUNT]: deleted.count,
      systemWide: true,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({ deleted: deleted.count });
}

export const POST = withRequestLog(handlePOST);
