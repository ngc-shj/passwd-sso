import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { API_ERROR } from "@/lib/api-error-codes";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { getSessionToken } from "../helpers";
import { withUserTenantRls } from "@/lib/tenant-context";
import { rateLimited } from "@/lib/api-response";

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

  const rl = await revokeLimiter.check(`rl:session_revoke:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { id } = await params;

  // Check if the target session is the current one
  const currentToken = getSessionToken(request);
  if (!currentToken) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const target = await withUserTenantRls(session.user.id, async () =>
    prisma.session.findFirst({
      where: { id, userId: session.user.id },
      select: { sessionToken: true },
    }),
  );
  if (target?.sessionToken === currentToken) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_REVOKE_CURRENT_SESSION },
      { status: 400 },
    );
  }

  // Delete with userId condition to prevent deleting other users' sessions
  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.session.deleteMany({
      where: { id, userId: session.user.id },
    }),
  );

  if (result.count === 0) {
    return NextResponse.json(
      { error: API_ERROR.SESSION_NOT_FOUND },
      { status: 404 },
    );
  }

  await logAuditAsync({
    ...personalAuditBase(request, session.user.id),
    action: AUDIT_ACTION.SESSION_REVOKE,
    targetType: AUDIT_TARGET_TYPE.SESSION,
    targetId: id,
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
