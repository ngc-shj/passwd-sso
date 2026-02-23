import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revokeEmergencyGrantSchema } from "@/lib/validations";
import { canTransition } from "@/lib/emergency-access-state";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { emergencyAccessRevokedEmail } from "@/lib/email/templates/emergency-access";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { routing } from "@/i18n/routing";

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
    if (!canTransition(grant.status, EA_STATUS.REVOKED)) {
      return NextResponse.json(
        { error: API_ERROR.INVALID_STATUS },
        { status: 400 }
      );
    }

    await prisma.emergencyAccessGrant.update({
      where: { id },
      data: {
        status: EA_STATUS.REVOKED,
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
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE,
      userId: session.user.id,
      targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
      targetId: id,
      metadata: { granteeId: grant.granteeId, permanent: true },
      ...extractRequestMeta(req),
    });

    if (grant.granteeId) {
      const grantee = await prisma.user.findUnique({
        where: { id: grant.granteeId },
        select: { email: true, name: true },
      });
      if (grantee?.email) {
        const ownerName = session.user.name ?? session.user.email ?? "";
        const { subject, html, text } = emergencyAccessRevokedEmail(routing.defaultLocale, ownerName);
        void sendEmail({ to: grantee.email, subject, html, text });
      }
    }

    return NextResponse.json({ status: EA_STATUS.REVOKED });
  } else {
    // Reject request only (revert to IDLE)
    if (!canTransition(grant.status, EA_STATUS.IDLE)) {
      return NextResponse.json(
        { error: API_ERROR.INVALID_STATUS },
        { status: 400 }
      );
    }

    await prisma.emergencyAccessGrant.update({
      where: { id },
      data: {
        status: EA_STATUS.IDLE,
        requestedAt: null,
        waitExpiresAt: null,
      },
    });

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE,
      userId: session.user.id,
      targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
      targetId: id,
      metadata: { granteeId: grant.granteeId, permanent: false },
      ...extractRequestMeta(req),
    });

    return NextResponse.json({ status: EA_STATUS.IDLE });
  }
}
