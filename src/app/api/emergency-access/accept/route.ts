import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { acceptEmergencyGrantSchema } from "@/lib/validations";
import { hashToken } from "@/lib/crypto/crypto-server";
import { fromStatusesFor } from "@/lib/emergency-access/emergency-access-state";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { sendEmail } from "@/lib/email";
import { emergencyGrantAcceptedEmail } from "@/lib/email/templates/emergency-access";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, rateLimited, unauthorized, notFound } from "@/lib/http/api-response";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { resolveUserLocale } from "@/lib/locale";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const acceptLimiter = createRateLimiter({ windowMs: 5 * MS_PER_MINUTE, max: 10 });

// POST /api/emergency-access/accept — Accept an emergency access invitation
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return unauthorized();
  }

  const rl = await acceptLimiter.check(`rl:ea_accept:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, acceptEmergencyGrantSchema);
  if (!result.ok) return result.response;
  const { token, granteePublicKey, encryptedPrivateKey } = result.data;

  // Hash the token for DB lookup (DB stores only the hash)
  const grant = await withBypassRls(prisma, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { tokenHash: hashToken(token) },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!grant) {
    return notFound();
  }

  if (grant.tokenExpiresAt < new Date()) {
    return errorResponse(API_ERROR.INVITATION_EXPIRED, 410);
  }

  if (grant.granteeEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return errorResponse(API_ERROR.INVITATION_WRONG_EMAIL, 403);
  }

  // Cannot accept own grant
  if (grant.ownerId === session.user.id) {
    return errorResponse(API_ERROR.CANNOT_GRANT_SELF, 400);
  }

  // Atomic compare-and-swap: only transitions a still-PENDING row, and only
  // creates the escrow key pair if the transition actually fired.
  const txResult = await withBypassRls(prisma, async () =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.emergencyAccessGrant.updateMany({
        where: {
          id: grant.id,
          tokenHash: grant.tokenHash,
          status: { in: fromStatusesFor(EA_STATUS.ACCEPTED) },
        },
        data: {
          status: EA_STATUS.ACCEPTED,
          granteeId: session.user.id,
          granteePublicKey,
        },
      });
      if (updated.count === 0) {
        return { ok: false as const };
      }
      await tx.emergencyAccessKeyPair.create({
        data: {
          grantId: grant.id,
          tenantId: grant.tenantId,
          encryptedPrivateKey: encryptedPrivateKey.ciphertext,
          privateKeyIv: encryptedPrivateKey.iv,
          privateKeyAuthTag: encryptedPrivateKey.authTag,
        },
      });
      return { ok: true as const };
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!txResult.ok) {
    return errorResponse(API_ERROR.INVITATION_ALREADY_USED, 410);
  }

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.EMERGENCY_GRANT_ACCEPT,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grant.id,
    metadata: { ownerId: grant.ownerId },
  });

  const owner = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: grant.ownerId },
      select: { email: true, name: true, locale: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  if (owner?.email) {
    const granteeName = session.user.name ?? session.user.email ?? "";
    const { subject, html, text } = emergencyGrantAcceptedEmail(resolveUserLocale(owner.locale), granteeName);
    void sendEmail({ to: owner.email, subject, html, text });
  }

  return NextResponse.json({ status: EA_STATUS.ACCEPTED });
}

export const POST = withRequestLog(handlePOST);
