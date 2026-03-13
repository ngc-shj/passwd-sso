import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { acceptEmergencyGrantSchema } from "@/lib/validations";
import { hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { emergencyGrantAcceptedEmail } from "@/lib/email/templates/emergency-access";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { resolveUserLocale } from "@/lib/locale";
import { withUserTenantRls } from "@/lib/tenant-context";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";

const acceptLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 10 });

// POST /api/emergency-access/accept — Accept an emergency access invitation
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await acceptLimiter.check(`rl:ea_accept:${session.user.id}`)).allowed) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  const result = await parseBody(req, acceptEmergencyGrantSchema);
  if (!result.ok) return result.response;
  const { token, granteePublicKey, encryptedPrivateKey } = result.data;

  // Hash the token for DB lookup (DB stores only the hash)
  const grant = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { tokenHash: hashToken(token) },
    }),
  );

  if (!grant) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 }
    );
  }

  if (grant.status !== EA_STATUS.PENDING) {
    return NextResponse.json({ error: API_ERROR.INVITATION_ALREADY_USED }, { status: 410 });
  }

  if (grant.tokenExpiresAt < new Date()) {
    return NextResponse.json({ error: API_ERROR.INVITATION_EXPIRED }, { status: 410 });
  }

  if (grant.granteeEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: API_ERROR.INVITATION_WRONG_EMAIL },
      { status: 403 }
    );
  }

  // Cannot accept own grant
  if (grant.ownerId === session.user.id) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_GRANT_SELF },
      { status: 400 }
    );
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction([
      prisma.emergencyAccessGrant.update({
        where: { id: grant.id },
        data: {
          status: EA_STATUS.ACCEPTED,
          granteeId: session.user.id,
          granteePublicKey,
        },
      }),
      prisma.emergencyAccessKeyPair.create({
        data: {
          grantId: grant.id,
          tenantId: grant.tenantId,
          encryptedPrivateKey: encryptedPrivateKey.ciphertext,
          privateKeyIv: encryptedPrivateKey.iv,
          privateKeyAuthTag: encryptedPrivateKey.authTag,
        },
      }),
    ]),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EMERGENCY_GRANT_ACCEPT,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grant.id,
    metadata: { ownerId: grant.ownerId },
    ...extractRequestMeta(req),
  });

  const owner = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: grant.ownerId },
      select: { email: true, name: true, locale: true },
    }),
  );
  if (owner?.email) {
    const granteeName = session.user.name ?? session.user.email ?? "";
    const { subject, html, text } = emergencyGrantAcceptedEmail(resolveUserLocale(owner.locale), granteeName);
    void sendEmail({ to: owner.email, subject, html, text });
  }

  return NextResponse.json({ status: EA_STATUS.ACCEPTED });
}

export const POST = withRequestLog(handlePOST);
