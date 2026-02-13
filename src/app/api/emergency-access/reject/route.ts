import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { rejectEmergencyGrantSchema } from "@/lib/validations";
import { hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE } from "@/lib/constants";

// POST /api/emergency-access/reject — Reject an emergency access invitation
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = rejectEmergencyGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() }, { status: 400 });
  }

  // Hash the token for DB lookup (DB stores only the hash)
  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { tokenHash: hashToken(parsed.data.token) },
  });

  if (!grant) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 }
    );
  }

  if (grant.status !== EA_STATUS.PENDING) {
    return NextResponse.json({ error: API_ERROR.INVITATION_ALREADY_USED }, { status: 410 });
  }

  if (grant.granteeEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: API_ERROR.INVITATION_WRONG_EMAIL },
      { status: 403 }
    );
  }

  await prisma.emergencyAccessGrant.update({
    where: { id: grant.id },
    data: { status: EA_STATUS.REJECTED },
  });

  logAudit({
    scope: "PERSONAL",
    action: "EMERGENCY_GRANT_REJECT",
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grant.id,
    metadata: { ownerId: grant.ownerId },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ status: EA_STATUS.REJECTED });
}
