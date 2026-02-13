import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { confirmEmergencyGrantSchema } from "@/lib/validations";
import { canTransition } from "@/lib/emergency-access-state";
import { SUPPORTED_KEY_ALGORITHMS } from "@/lib/crypto-emergency";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

// POST /api/emergency-access/[id]/confirm — Owner performs key escrow
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { id },
  });

  if (!grant || grant.ownerId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (!canTransition(grant.status, EA_STATUS.IDLE)) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_STATUS },
      { status: 400 }
    );
  }

  // Fetch owner's current keyVersion from DB (server-authoritative)
  const owner = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { keyVersion: true },
  });

  if (!owner) {
    return NextResponse.json({ error: API_ERROR.USER_NOT_FOUND }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = confirmEmergencyGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() }, { status: 400 });
  }

  const { ownerEphemeralPublicKey, encryptedSecretKey, secretKeyIv, secretKeyAuthTag, hkdfSalt, wrapVersion } = parsed.data;

  // Validate keyAlgorithm is compatible with wrapVersion
  const allowedAlgorithms = SUPPORTED_KEY_ALGORITHMS[wrapVersion];
  if (!allowedAlgorithms?.includes(grant.keyAlgorithm)) {
    return NextResponse.json(
      { error: API_ERROR.INCOMPATIBLE_KEY_ALGORITHM },
      { status: 400 }
    );
  }

  // Use server-fetched keyVersion, ignore client-sent value
  const serverKeyVersion = owner.keyVersion;

  await prisma.emergencyAccessGrant.update({
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
  });

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EMERGENCY_GRANT_CONFIRM,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: id,
    metadata: { granteeId: grant.granteeId, wrapVersion, keyVersion: serverKeyVersion },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ status: EA_STATUS.IDLE, keyVersion: serverKeyVersion });
}
