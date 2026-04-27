/**
 * POST /api/admin/rotate-master-key
 *
 * Revokes share links encrypted with old master key versions.
 *
 * Note:
 * - Team vault encryption is E2E-only; server-side team key re-wrap is removed.
 * - This endpoint validates the target master key version and optionally
 *   revokes old-version PasswordShare rows.
 * Authenticated via per-operator op_* token (mint via /dashboard/tenant/operator-tokens).
 *
 * Body: { targetVersion: number, revokeShares?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/http/parse-body";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized } from "@/lib/http/api-response";
import { MASTER_KEY_VERSION_MIN, MASTER_KEY_VERSION_MAX } from "@/lib/validations/common.server";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const bodySchema = z.object({
  targetVersion: z.number().int().min(MASTER_KEY_VERSION_MIN).max(MASTER_KEY_VERSION_MAX),
  revokeShares: z.boolean().default(false),
});

async function handlePOST(req: NextRequest) {
  // Bearer token auth (checked before rate limit to prevent unauthenticated DoS)
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  // Rate limit (global fixed key, applied after auth)
  const rl = await rateLimiter.check("rl:admin:rotate");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Parse body
  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { targetVersion, revokeShares } = result.data;

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

  // Re-confirm the operator is still an active OWNER/ADMIN of their bound tenant
  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  // Revoke old-version shares across ALL tenants (master key is system-wide)
  let revokedShares = 0;
  if (revokeShares) {
    const shareResult = await withBypassRls(prisma, async () =>
      prisma.passwordShare.updateMany({
        where: {
          masterKeyVersion: { lt: targetVersion },
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
    revokedShares = shareResult.count;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.MASTER_KEY_ROTATION,
    metadata: {
      tokenSubjectUserId: auth.subjectUserId,
      tokenId: auth.tokenId,
      targetVersion,
      revokedShares,
    },
  });

  return NextResponse.json({ targetVersion, revokedShares });
}

export const POST = withRequestLog(handlePOST);
