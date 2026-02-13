import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canTransition } from "@/lib/emergency-access-state";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

const requestLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 3 });

// POST /api/emergency-access/[id]/request — Grantee requests emergency access
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await requestLimiter.check(`rl:ea_request:${session.user.id}`))) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  const { id } = await params;

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { id },
  });

  if (!grant || grant.granteeId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (!canTransition(grant.status, EA_STATUS.REQUESTED)) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_STATUS },
      { status: 400 }
    );
  }

  const now = new Date();
  const waitExpiresAt = new Date(now.getTime() + grant.waitDays * 24 * 60 * 60 * 1000);

  await prisma.emergencyAccessGrant.update({
    where: { id },
    data: {
      status: EA_STATUS.REQUESTED,
      requestedAt: now,
      waitExpiresAt,
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EMERGENCY_ACCESS_REQUEST,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: id,
    metadata: { ownerId: grant.ownerId, waitDays: grant.waitDays },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({
    status: EA_STATUS.REQUESTED,
    requestedAt: now.toISOString(),
    waitExpiresAt: waitExpiresAt.toISOString(),
  });
}
