import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canTransition } from "@/lib/emergency-access-state";
import { logAudit, extractRequestMeta } from "@/lib/audit";

// POST /api/emergency-access/[id]/approve — Owner early-approves emergency access request
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { id },
  });

  if (!grant || grant.ownerId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!canTransition(grant.status, "ACTIVATED")) {
    return NextResponse.json(
      { error: `Cannot approve grant in ${grant.status} status` },
      { status: 400 }
    );
  }

  await prisma.emergencyAccessGrant.update({
    where: { id },
    data: {
      status: "ACTIVATED",
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

  return NextResponse.json({ status: "ACTIVATED" });
}
