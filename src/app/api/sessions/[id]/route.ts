import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { API_ERROR } from "@/lib/api-error-codes";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { getSessionToken } from "../helpers";

const revokeLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

async function handleDELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  if (
    !(await revokeLimiter.check(`rl:session_revoke:${session.user.id}`))
  ) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  const { id } = await params;

  // Check if the target session is the current one
  const currentToken = getSessionToken(request);
  if (currentToken) {
    const target = await prisma.session.findFirst({
      where: { id, userId: session.user.id },
      select: { sessionToken: true },
    });
    if (target?.sessionToken === currentToken) {
      return NextResponse.json(
        { error: API_ERROR.CANNOT_REVOKE_CURRENT_SESSION },
        { status: 400 },
      );
    }
  }

  // Delete with userId condition to prevent deleting other users' sessions
  const result = await prisma.session.deleteMany({
    where: { id, userId: session.user.id },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { error: API_ERROR.SESSION_NOT_FOUND },
      { status: 404 },
    );
  }

  const meta = extractRequestMeta(request);
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SESSION_REVOKE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.SESSION,
    targetId: id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
