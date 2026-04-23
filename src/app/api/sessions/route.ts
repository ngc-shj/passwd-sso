import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import { API_ERROR } from "@/lib/api-error-codes";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { getSessionToken } from "./helpers";
import { withUserTenantRls, resolveUserTenantId } from "@/lib/tenant-context";
import { rateLimited } from "@/lib/api-response";
import { revokeAllExtensionTokensForUser } from "@/lib/auth/extension-token";

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

  // Parallelize independent queries
  const [sessions, tenant, currentSessionId] = await withUserTenantRls(
    session.user.id,
    () =>
      Promise.all([
        prisma.session.findMany({
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
        }),
        prisma.user.findUnique({
          where: { id: session.user.id },
          select: { tenant: { select: { maxConcurrentSessions: true } } },
        }),
        currentToken
          ? prisma.session
              .findUnique({
                where: { sessionToken: currentToken },
                select: { id: true },
              })
              .then((r) => r?.id ?? null)
          : Promise.resolve(null),
      ]),
  );

  const items = sessions.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    lastActiveAt: s.lastActiveAt.toISOString(),
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    isCurrent: s.id === currentSessionId,
  }));

  return NextResponse.json({
    sessions: items,
    sessionCount: items.length,
    maxConcurrentSessions: tenant?.tenant?.maxConcurrentSessions ?? null,
  });
}

async function handleDELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const rl = await revokeAllLimiter.check(`rl:session_revoke_all:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const currentToken = getSessionToken(request);
  if (!currentToken) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.session.deleteMany({
      where: {
        userId: session.user.id,
        sessionToken: { not: currentToken },
      },
    }),
  );

  // "Sign out everywhere" must also revoke all extension tokens since they
  // are bearer credentials distinct from Auth.js sessions.
  const tenantId = await resolveUserTenantId(session.user.id);
  if (tenantId) {
    await revokeAllExtensionTokensForUser({
      userId: session.user.id,
      tenantId,
      reason: "sign_out_everywhere",
    });
  }

  await logAuditAsync({
    ...personalAuditBase(request, session.user.id),
    action: AUDIT_ACTION.SESSION_REVOKE_ALL,
    metadata: { revokedCount: result.count },
  });

  return NextResponse.json({ revokedCount: result.count });
}

export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
