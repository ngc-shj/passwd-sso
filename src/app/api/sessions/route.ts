import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { API_ERROR } from "@/lib/api-error-codes";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { getSessionToken } from "./helpers";

const revokeAllLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

async function handleGET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const currentToken = getSessionToken(request);

  // Look up current session ID without loading all tokens into memory
  let currentSessionId: string | null = null;
  if (currentToken) {
    const current = await prisma.session.findUnique({
      where: { sessionToken: currentToken },
      select: { id: true },
    });
    currentSessionId = current?.id ?? null;
  }

  const sessions = await prisma.session.findMany({
    where: {
      userId: session.user.id,
      expires: { gt: new Date() },
    },
    select: {
      id: true,
      createdAt: true,
      lastActiveAt: true,
      ipAddress: true,
      userAgent: true,
    },
    orderBy: { lastActiveAt: "desc" },
  });

  const result = sessions.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    lastActiveAt: s.lastActiveAt.toISOString(),
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    isCurrent: s.id === currentSessionId,
  }));

  return NextResponse.json(result);
}

async function handleDELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  if (
    !(await revokeAllLimiter.check(`rl:session_revoke_all:${session.user.id}`))
  ) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  const currentToken = getSessionToken(request);
  if (!currentToken) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const result = await prisma.session.deleteMany({
    where: {
      userId: session.user.id,
      sessionToken: { not: currentToken },
    },
  });

  const meta = extractRequestMeta(request);
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.SESSION_REVOKE_ALL,
    userId: session.user.id,
    metadata: { revokedCount: result.count },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({ revokedCount: result.count });
}

export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
