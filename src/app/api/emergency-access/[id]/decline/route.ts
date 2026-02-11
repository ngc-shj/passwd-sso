import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS } from "@/lib/constants";

// POST /api/emergency-access/[id]/decline — Decline a grant by ID (authenticated grantee)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { id },
  });

  if (!grant) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (grant.status !== EA_STATUS.PENDING) {
    return NextResponse.json({ error: API_ERROR.GRANT_NOT_PENDING }, { status: 400 });
  }

  if (grant.granteeEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json({ error: API_ERROR.NOT_AUTHORIZED_FOR_GRANT }, { status: 403 });
  }

  await prisma.emergencyAccessGrant.update({
    where: { id },
    data: { status: EA_STATUS.REJECTED },
  });

  logAudit({
    scope: "PERSONAL",
    action: "EMERGENCY_GRANT_REJECT",
    userId: session.user.id,
    targetType: "EmergencyAccessGrant",
    targetId: id,
    metadata: { ownerId: grant.ownerId },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ status: EA_STATUS.REJECTED });
}
