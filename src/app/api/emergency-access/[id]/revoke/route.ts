import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revokeEmergencyGrantSchema } from "@/lib/validations";
import { canTransition } from "@/lib/emergency-access/emergency-access-state";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { sendEmail } from "@/lib/email";
import { emergencyAccessRevokedEmail } from "@/lib/email/templates/emergency-access";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { resolveUserLocale } from "@/lib/locale";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

// POST /api/emergency-access/[id]/revoke — Owner revokes or rejects request
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
      select: { ownerId: true, status: true, granteeId: true },
    }),
  );

  if (!grant || grant.ownerId !== session.user.id) {
    return notFound();
  }

  const result = await parseBody(req, revokeEmergencyGrantSchema);
  if (!result.ok) return result.response;
  const { permanent } = result.data;

  if (permanent) {
    // Full revoke
    if (!canTransition(grant.status, EA_STATUS.REVOKED)) {
      return errorResponse(API_ERROR.INVALID_STATUS, 400);
    }

    await withUserTenantRls(session.user.id, async () =>
      prisma.emergencyAccessGrant.update({
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
      }),
    );

    await logAuditAsync({
      ...personalAuditBase(req, session.user.id),
      action: AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE,
      targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
      targetId: id,
      metadata: { ownerId: grant.ownerId, granteeId: grant.granteeId, permanent: true },
    });

    const granteeId = grant.granteeId;
    if (granteeId) {
      // Bypass RLS: grantee may be in a different tenant
      const grantee = await withBypassRls(prisma, async () =>
        prisma.user.findUnique({
          where: { id: granteeId },
          select: { email: true, name: true, locale: true },
        }),
      BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
      if (grantee?.email) {
        const ownerName = session.user.name ?? session.user.email ?? "";
        const { subject, html, text } = emergencyAccessRevokedEmail(resolveUserLocale(grantee.locale), ownerName);
        void sendEmail({ to: grantee.email, subject, html, text });
      }
    }

    return NextResponse.json({ status: EA_STATUS.REVOKED });
  } else {
    // Reject request only (revert to IDLE)
    if (!canTransition(grant.status, EA_STATUS.IDLE)) {
      return errorResponse(API_ERROR.INVALID_STATUS, 400);
    }

    await withUserTenantRls(session.user.id, async () =>
      prisma.emergencyAccessGrant.update({
        where: { id },
        data: {
          status: EA_STATUS.IDLE,
          requestedAt: null,
          waitExpiresAt: null,
        },
      }),
    );

    await logAuditAsync({
      ...personalAuditBase(req, session.user.id),
      action: AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE,
      targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
      targetId: id,
      metadata: { ownerId: grant.ownerId, granteeId: grant.granteeId, permanent: false },
    });

    return NextResponse.json({ status: EA_STATUS.IDLE });
  }
}

export const POST = withRequestLog(handlePOST);
