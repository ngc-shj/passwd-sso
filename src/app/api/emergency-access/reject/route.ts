import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { rejectEmergencyGrantSchema } from "@/lib/validations";
import { logAudit, extractRequestMeta } from "@/lib/audit";

// POST /api/emergency-access/reject — Reject an emergency access invitation
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = rejectEmergencyGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { token: parsed.data.token },
  });

  if (!grant) {
    return NextResponse.json({ error: "Invalid invitation" }, { status: 404 });
  }

  if (grant.status !== "PENDING") {
    return NextResponse.json({ error: "Invitation already used" }, { status: 410 });
  }

  if (grant.granteeEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "Invitation was sent to a different email" },
      { status: 403 }
    );
  }

  await prisma.emergencyAccessGrant.update({
    where: { id: grant.id },
    data: { status: "REJECTED" },
  });

  logAudit({
    scope: "PERSONAL",
    action: "EMERGENCY_GRANT_REJECT",
    userId: session.user.id,
    targetType: "EmergencyAccessGrant",
    targetId: grant.id,
    metadata: { ownerId: grant.ownerId },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ status: "REJECTED" });
}
