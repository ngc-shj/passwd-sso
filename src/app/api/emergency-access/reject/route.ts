import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { rejectEmergencyGrantSchema } from "@/lib/validations";
import { hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, personalAuditBase } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { emergencyGrantDeclinedEmail } from "@/lib/email/templates/emergency-access";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, notFound } from "@/lib/api-response";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { resolveUserLocale } from "@/lib/locale";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";

// POST /api/emergency-access/reject — Reject an emergency access invitation
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return unauthorized();
  }

  const result = await parseBody(req, rejectEmergencyGrantSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Hash the token for DB lookup (DB stores only the hash)
  const grant = await withBypassRls(prisma, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { tokenHash: hashToken(data.token) },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!grant) {
    return notFound();
  }

  if (grant.status !== EA_STATUS.PENDING) {
    return errorResponse(API_ERROR.INVITATION_ALREADY_USED, 410);
  }

  if (grant.granteeEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return errorResponse(API_ERROR.INVITATION_WRONG_EMAIL, 403);
  }

  await withBypassRls(prisma, async () =>
    prisma.emergencyAccessGrant.update({
      where: { id: grant.id },
      data: { status: EA_STATUS.REJECTED },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.EMERGENCY_GRANT_REJECT,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grant.id,
    metadata: { ownerId: grant.ownerId, rejectedBy: session.user.id },
  });

  const owner = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: grant.ownerId },
      select: { email: true, name: true, locale: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  if (owner?.email) {
    const granteeName = session.user.name ?? session.user.email ?? "";
    const { subject, html, text } = emergencyGrantDeclinedEmail(resolveUserLocale(owner.locale), granteeName);
    void sendEmail({ to: owner.email, subject, html, text });
  }

  return NextResponse.json({ status: EA_STATUS.REJECTED });
}

export const POST = withRequestLog(handlePOST);
