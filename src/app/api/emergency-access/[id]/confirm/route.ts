import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { confirmEmergencyGrantSchema } from "@/lib/validations";
import { fromStatusesFor } from "@/lib/emergency-access/emergency-access-state";
import { SUPPORTED_KEY_ALGORITHMS } from "@/lib/crypto/crypto-emergency";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";

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

  // Atomic compare-and-swap on status: prevents racing a concurrent revoke
  // that would otherwise let stale escrow data overwrite a REVOKED grant.
  const updated = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.updateMany({
      where: {
        id,
        ownerId: session.user.id,
        status: { in: fromStatusesFor(EA_STATUS.IDLE) },
      },
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

  if (updated.count === 0) {
    return errorResponse(API_ERROR.INVALID_STATUS, 400);
  }

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
