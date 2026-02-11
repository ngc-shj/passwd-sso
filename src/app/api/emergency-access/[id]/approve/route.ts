import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canTransition } from "@/lib/emergency-access-state";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS } from "@/lib/constants";

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

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { id },
  });

  if (!grant || grant.ownerId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (!canTransition(grant.status, EA_STATUS.ACTIVATED)) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_STATUS },
      { status: 400 }
    );
  }

  await prisma.emergencyAccessGrant.update({
    where: { id },
    data: {
      status: EA_STATUS.ACTIVATED,
      activatedAt: new Date(),
    },
  });

  logAudit({
    scope: "PERSONAL",
    action: "EMERGENCY_ACCESS_ACTIVATE",
    userId: session.user.id,
    targetType: "EmergencyAccessGrant",
    targetId: id,
    metadata: { granteeId: grant.granteeId, earlyApproval: true },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ status: EA_STATUS.ACTIVATED });
}
