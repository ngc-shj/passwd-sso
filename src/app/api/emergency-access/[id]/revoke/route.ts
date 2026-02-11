import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revokeEmergencyGrantSchema } from "@/lib/validations";
import { canTransition } from "@/lib/emergency-access-state";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";

// POST /api/emergency-access/[id]/revoke — Owner revokes or rejects request
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = revokeEmergencyGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() }, { status: 400 });
  }

  const { permanent } = parsed.data;

  if (permanent) {
    // Full revoke
    if (!canTransition(grant.status, "REVOKED")) {
      return NextResponse.json(
        { error: API_ERROR.INVALID_STATUS },
        { status: 400 }
      );
    }

    await prisma.emergencyAccessGrant.update({
      where: { id },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        // Clear crypto data (defense in depth)
        encryptedSecretKey: null,
        secretKeyIv: null,
        secretKeyAuthTag: null,
        ownerEphemeralPublicKey: null,
        hkdfSalt: null,
      },
    });

    logAudit({
      scope: "PERSONAL",
      action: "EMERGENCY_ACCESS_REVOKE",
      userId: session.user.id,
      targetType: "EmergencyAccessGrant",
      targetId: id,
      metadata: { granteeId: grant.granteeId, permanent: true },
      ...extractRequestMeta(req),
    });

    return NextResponse.json({ status: "REVOKED" });
  } else {
    // Reject request only (revert to IDLE)
    if (!canTransition(grant.status, "IDLE")) {
      return NextResponse.json(
        { error: API_ERROR.INVALID_STATUS },
        { status: 400 }
      );
    }

    await prisma.emergencyAccessGrant.update({
      where: { id },
      data: {
        status: "IDLE",
        requestedAt: null,
        waitExpiresAt: null,
      },
    });

    logAudit({
      scope: "PERSONAL",
      action: "EMERGENCY_ACCESS_REVOKE",
      userId: session.user.id,
      targetType: "EmergencyAccessGrant",
      targetId: id,
      metadata: { granteeId: grant.granteeId, permanent: false },
      ...extractRequestMeta(req),
    });

    return NextResponse.json({ status: "IDLE" });
  }
}
