import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { confirmEmergencyGrantSchema } from "@/lib/validations";
import { canTransition } from "@/lib/emergency-access-state";
import { SUPPORTED_KEY_ALGORITHMS } from "@/lib/crypto/crypto-emergency";
import { logAuditAsync, personalAuditBase } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

// POST /api/emergency-access/[id]/confirm — Owner performs key escrow
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const grant = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { id },
    }),
  );

  if (!grant || grant.ownerId !== session.user.id) {
    return notFound();
  }

  if (!canTransition(grant.status, EA_STATUS.IDLE)) {
    return errorResponse(API_ERROR.INVALID_STATUS, 400);
  }

  // Fetch owner's current keyVersion from DB (server-authoritative)
  const owner = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { keyVersion: true },
    }),
  );

  if (!owner) {
    return errorResponse(API_ERROR.USER_NOT_FOUND, 404);
  }

  const result = await parseBody(req, confirmEmergencyGrantSchema);
  if (!result.ok) return result.response;
  const { ownerEphemeralPublicKey, encryptedSecretKey, secretKeyIv, secretKeyAuthTag, hkdfSalt, wrapVersion } = result.data;

  // Validate keyAlgorithm is compatible with wrapVersion
  const allowedAlgorithms = SUPPORTED_KEY_ALGORITHMS[wrapVersion];
  if (!allowedAlgorithms?.includes(grant.keyAlgorithm)) {
    return errorResponse(API_ERROR.INCOMPATIBLE_KEY_ALGORITHM, 400);
  }

  // Use server-fetched keyVersion, ignore client-sent value
  const serverKeyVersion = owner.keyVersion;

  await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.update({
      where: { id },
      data: {
        status: EA_STATUS.IDLE,
        ownerEphemeralPublicKey,
        encryptedSecretKey,
        secretKeyIv,
        secretKeyAuthTag,
        hkdfSalt,
        wrapVersion,
        keyVersion: serverKeyVersion,
      },
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.EMERGENCY_GRANT_CONFIRM,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: id,
    metadata: { ownerId: grant.ownerId, granteeId: grant.granteeId, wrapVersion, keyVersion: serverKeyVersion },
  });

  return NextResponse.json({ status: EA_STATUS.IDLE, keyVersion: serverKeyVersion });
}

export const POST = withRequestLog(handlePOST);
