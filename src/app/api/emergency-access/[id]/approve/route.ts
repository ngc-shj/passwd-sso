import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { fromStatusesFor } from "@/lib/emergency-access/emergency-access-state";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { sendEmail } from "@/lib/email";
import { emergencyAccessApprovedEmail } from "@/lib/email/templates/emergency-access";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { resolveUserLocale } from "@/lib/locale";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";

// POST /api/emergency-access/[id]/approve — Owner early-approves emergency access request
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
      select: { ownerId: true, granteeId: true },
    }),
  );

  if (!grant || grant.ownerId !== session.user.id) {
    return notFound();
  }

  // Atomic compare-and-swap on status: blocks concurrent transitions out of the
  // permitted from-set even if a parallel revoke/request/etc. lands between
  // the read above and this write.
  const updated = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.updateMany({
      where: {
        id,
        ownerId: session.user.id,
        status: { in: fromStatusesFor(EA_STATUS.ACTIVATED) },
      },
      data: {
        status: EA_STATUS.ACTIVATED,
        activatedAt: new Date(),
      },
    }),
  );

  if (updated.count === 0) {
    return errorResponse(API_ERROR.INVALID_STATUS, 400);
  }

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: id,
    metadata: { granteeId: grant.granteeId, earlyApproval: true },
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
      const { subject, html, text } = emergencyAccessApprovedEmail(resolveUserLocale(grantee.locale), ownerName);
      void sendEmail({ to: grantee.email, subject, html, text });
    }
  }

  return NextResponse.json({ status: EA_STATUS.ACTIVATED });
}

export const POST = withRequestLog(handlePOST);
