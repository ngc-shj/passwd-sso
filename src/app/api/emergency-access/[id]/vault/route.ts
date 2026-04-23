import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, rateLimited, notFound, unauthorized } from "@/lib/api-response";

const vaultLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// GET /api/emergency-access/[id]/vault — Get ECDH data for vault access
async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await vaultLimiter.check(`rl:ea_vault:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { id } = await params;

  const grant = await withBypassRls(prisma, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { id },
      include: {
        granteeKeyPair: true,
        owner: { select: { name: true, email: true } },
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!grant || grant.granteeId !== session.user.id) {
    return notFound();
  }

  // Auto-activate if wait period has expired
  if (grant.status === EA_STATUS.REQUESTED && grant.waitExpiresAt && grant.waitExpiresAt <= new Date()) {
    await withBypassRls(prisma, async () =>
      prisma.emergencyAccessGrant.update({
        where: { id },
        data: { status: EA_STATUS.ACTIVATED, activatedAt: new Date() },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
    grant.status = EA_STATUS.ACTIVATED;

    await logAuditAsync({
      ...personalAuditBase(req, session.user.id),
      action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE,
      targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
      targetId: id,
      metadata: { ownerId: grant.ownerId },
    });
  }

  if (grant.status !== EA_STATUS.ACTIVATED) {
    return errorResponse(API_ERROR.NOT_ACTIVATED, 403);
  }

  if (!grant.encryptedSecretKey || !grant.granteeKeyPair) {
    return errorResponse(API_ERROR.KEY_ESCROW_NOT_COMPLETED, 400);
  }

  return NextResponse.json({
    grantId: grant.id,
    ownerId: grant.ownerId,
    granteeId: grant.granteeId,
    ownerEphemeralPublicKey: grant.ownerEphemeralPublicKey,
    encryptedSecretKey: grant.encryptedSecretKey,
    secretKeyIv: grant.secretKeyIv,
    secretKeyAuthTag: grant.secretKeyAuthTag,
    hkdfSalt: grant.hkdfSalt,
    wrapVersion: grant.wrapVersion,
    keyVersion: grant.keyVersion,
    keyAlgorithm: grant.keyAlgorithm,
    granteeKeyPair: {
      encryptedPrivateKey: grant.granteeKeyPair.encryptedPrivateKey,
      privateKeyIv: grant.granteeKeyPair.privateKeyIv,
      privateKeyAuthTag: grant.granteeKeyPair.privateKeyAuthTag,
    },
    owner: grant.owner,
  });
}

export const GET = withRequestLog(handleGET);
