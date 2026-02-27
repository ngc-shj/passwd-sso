import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canTransition } from "@/lib/emergency-access-state";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { emergencyAccessApprovedEmail } from "@/lib/email/templates/emergency-access";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { routing } from "@/i18n/routing";
import { withUserTenantRls } from "@/lib/tenant-context";

// POST /api/emergency-access/[id]/approve — Owner early-approves emergency access request
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const grant = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { id },
    }),
  );

  if (!grant || grant.ownerId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (!canTransition(grant.status, EA_STATUS.ACTIVATED)) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_STATUS },
      { status: 400 }
    );
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.update({
      where: { id },
      data: {
        status: EA_STATUS.ACTIVATED,
        activatedAt: new Date(),
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: id,
    metadata: { granteeId: grant.granteeId, earlyApproval: true },
    ...extractRequestMeta(req),
  });

  const granteeId = grant.granteeId;
  if (granteeId) {
    const grantee = await withUserTenantRls(session.user.id, async () =>
      prisma.user.findUnique({
        where: { id: granteeId },
        select: { email: true, name: true },
      }),
    );
    if (grantee?.email) {
      const ownerName = session.user.name ?? session.user.email ?? "";
      const { subject, html, text } = emergencyAccessApprovedEmail(routing.defaultLocale, ownerName);
      void sendEmail({ to: grantee.email, subject, html, text });
    }
  }

  return NextResponse.json({ status: EA_STATUS.ACTIVATED });
}
