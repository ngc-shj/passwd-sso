/**
 * POST /api/admin/rotate-master-key
 *
 * Revokes share links encrypted with old master key versions.
 *
 * Note:
 * - Team vault encryption is E2E-only; server-side team key re-wrap is removed.
 * - This endpoint now validates the target master key version and optionally
 *   revokes old-version PasswordShare rows.
 * Authenticated via ADMIN_API_TOKEN bearer token (not session).
 *
 * Body: { targetVersion: number, operatorId: string, revokeShares?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/admin-token";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/parse-body";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, unauthorized } from "@/lib/api-response";
import { MASTER_KEY_VERSION_MIN, MASTER_KEY_VERSION_MAX } from "@/lib/validations/common.server";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const bodySchema = z.object({
  targetVersion: z.number().int().min(MASTER_KEY_VERSION_MIN).max(MASTER_KEY_VERSION_MAX),
  operatorId: z.string().uuid(),
  revokeShares: z.boolean().default(false),
});

async function handlePOST(req: NextRequest) {
  // Bearer token auth (checked before rate limit to prevent unauthenticated DoS)
  if (!verifyAdminToken(req)) {
    return unauthorized();
  }

  // Rate limit (global fixed key, applied after auth)
  const rl = await rateLimiter.check("rl:admin:rotate");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Parse body
  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { targetVersion, operatorId, revokeShares } = result.data;

  // Verify targetVersion matches current env config (prevent stale requests)
  const currentVersion = getCurrentMasterKeyVersion();
  if (targetVersion !== currentVersion) {
    return NextResponse.json(
      {
        error: `targetVersion (${targetVersion}) does not match SHARE_MASTER_KEY_CURRENT_VERSION (${currentVersion})`,
      },
      { status: 400 }
    );
  }

  // Verify the target version key exists
  try {
    getMasterKeyByVersion(targetVersion);
  } catch {
    return NextResponse.json(
      { error: `SHARE_MASTER_KEY_V${targetVersion} is not configured` },
      { status: 400 }
    );
  }

  // Verify operatorId is a valid user
  const operator = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: operatorId },
      select: { id: true, tenantId: true },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  if (!operator) {
    return NextResponse.json(
      { error: "operatorId does not match an existing user" },
      { status: 400 }
    );
  }

  // Revoke old-version shares if requested
  // Revoke shares across ALL tenants (master key is system-wide)
  let revokedShares = 0;
  if (revokeShares) {
    const result = await withBypassRls(prisma, async () =>
      prisma.passwordShare.updateMany({
        where: {
          masterKeyVersion: { lt: targetVersion },
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
    revokedShares = result.count;
  }

  // Audit log (async nonblocking; logAudit handles errors internally)
  const { ip } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.MASTER_KEY_ROTATION,
    userId: operatorId,
    tenantId: operator.tenantId,
    metadata: {
      targetVersion,
      revokedShares,
    },
    ip,
  });

  return NextResponse.json({
    targetVersion,
    revokedShares,
  });
}

export const POST = withRequestLog(handlePOST);
