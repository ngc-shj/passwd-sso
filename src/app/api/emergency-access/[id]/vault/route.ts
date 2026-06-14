import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { personalAuditBase } from "@/lib/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { EA_STATUS } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, rateLimited, notFound, unauthorized } from "@/lib/http/api-response";
import { autoPromoteIfElapsed } from "@/lib/emergency-access/vault-auto-promote";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

const vaultLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 10 });

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

  const grant = await withBypassRls(prisma, async (tx) =>
    tx.emergencyAccessGrant.findUnique({
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

  // Auto-activate if wait period has expired (CAS-protected via transition() — closes
  // the race window where two concurrent GETs both flip REQUESTED → ACTIVATED).
  // The lib does not call withBypassRls itself; the route owns the bypass scope
  // (preserves the existing check-bypass-rls.mjs ALLOWED_USAGE entry for this file).
  if (grant.status === EA_STATUS.REQUESTED && grant.waitExpiresAt && grant.waitExpiresAt <= new Date()) {
    const result = await withBypassRls(
      prisma,
      async (tx) =>
        autoPromoteIfElapsed({
          granteeId: session.user.id,
          grantId: id,
          now: new Date(),
          auditBase: personalAuditBase(req, session.user.id),
        }),
      BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
    );

    if (result.ok) {
      return NextResponse.json({
        grantId: result.grant.id,
        ownerId: result.grant.ownerId,
        granteeId: result.grant.granteeId,
        ownerEphemeralPublicKey: result.grant.ownerEphemeralPublicKey,
        encryptedSecretKey: result.grant.encryptedSecretKey,
        secretKeyIv: result.grant.secretKeyIv,
        secretKeyAuthTag: result.grant.secretKeyAuthTag,
        hkdfSalt: result.grant.hkdfSalt,
        wrapVersion: result.grant.wrapVersion,
        keyVersion: result.grant.keyVersion,
        keyAlgorithm: result.grant.keyAlgorithm,
        granteeKeyPair: result.grant.granteeKeyPair && {
          encryptedPrivateKey: result.grant.granteeKeyPair.encryptedPrivateKey,
          privateKeyIv: result.grant.granteeKeyPair.privateKeyIv,
          privateKeyAuthTag: result.grant.granteeKeyPair.privateKeyAuthTag,
        },
        owner: result.grant.owner,
      });
    }

    if (result.reason === "revoked") {
      return errorResponse(API_ERROR.GRANT_REVOKED);
    }

    if (result.reason === "no_escrow") {
      return errorResponse(API_ERROR.EMERGENCY_RECOVERY_KEY_MISSING);
    }

    // reason === "not_eligible": fall through to the status check below
  }

  if (grant.status !== EA_STATUS.ACTIVATED) {
    return errorResponse(API_ERROR.NOT_ACTIVATED);
  }

  if (!grant.encryptedSecretKey || !grant.granteeKeyPair) {
    return errorResponse(API_ERROR.EMERGENCY_RECOVERY_KEY_MISSING);
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
