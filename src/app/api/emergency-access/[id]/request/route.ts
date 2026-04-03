import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canTransition } from "@/lib/emergency-access-state";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { emergencyAccessRequestedEmail } from "@/lib/email/templates/emergency-access";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { resolveUserLocale } from "@/lib/locale";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, rateLimited, notFound, unauthorized } from "@/lib/api-response";

const requestLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 3 });

// POST /api/emergency-access/[id]/request — Grantee requests emergency access
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await requestLimiter.check(`rl:ea_request:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { id } = await params;

  const grant = await withBypassRls(prisma, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { id },
      select: { granteeId: true, status: true, ownerId: true, waitDays: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!grant || grant.granteeId !== session.user.id) {
    return notFound();
  }

  if (!canTransition(grant.status, EA_STATUS.REQUESTED)) {
    return errorResponse(API_ERROR.INVALID_STATUS, 400);
  }

  const now = new Date();
  const waitExpiresAt = new Date(now.getTime() + grant.waitDays * 24 * 60 * 60 * 1000);

  await withBypassRls(prisma, async () =>
    prisma.emergencyAccessGrant.update({
      where: { id },
      data: {
        status: EA_STATUS.REQUESTED,
        requestedAt: now,
        waitExpiresAt,
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EMERGENCY_ACCESS_REQUEST,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: id,
    metadata: { ownerId: grant.ownerId, granteeId: grant.granteeId, waitDays: grant.waitDays },
    ...extractRequestMeta(req),
  });

  const [owner, grantee] = await Promise.all([
    withBypassRls(prisma, async () =>
      prisma.user.findUnique({
        where: { id: grant.ownerId },
        select: { email: true, name: true, locale: true },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP),
    withBypassRls(prisma, async () =>
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { name: true, email: true },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP),
  ]);
  if (owner?.email) {
    const granteeName = grantee?.name ?? grantee?.email ?? "";
    const { subject, html, text } = emergencyAccessRequestedEmail(resolveUserLocale(owner.locale), granteeName, grant.waitDays);
    void sendEmail({ to: owner.email, subject, html, text });
  }

  return NextResponse.json({
    status: EA_STATUS.REQUESTED,
    requestedAt: now.toISOString(),
    waitExpiresAt: waitExpiresAt.toISOString(),
  });
}

export const POST = withRequestLog(handlePOST);
