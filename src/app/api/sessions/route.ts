import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getSessionToken } from "./helpers";
import { withUserTenantRls, resolveUserTenantId } from "@/lib/tenant-context";
import { rateLimited } from "@/lib/http/api-response";
import { revokeAllExtensionTokensForUser } from "@/lib/auth/tokens/extension-token";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";

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
  const [sessions, tenant, currentSessionId, extensionTokens] = await withUserTenantRls(
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
        // iOS AutoFill MVP: surface non-cookie token sessions (browser
        // extensions + iOS apps) alongside Auth.js sessions so users can
        // identify and revoke a specific device. clientKind distinguishes
        // BROWSER_EXTENSION from IOS_APP; lastUsedIp/UA are populated by
        // the iOS DPoP path (browser rows leave them NULL).
        prisma.extensionToken.findMany({
          where: {
            userId: session.user.id,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: {
            id: true,
            createdAt: true,
            lastUsedAt: true,
            expiresAt: true,
            clientKind: true,
            lastUsedIp: true,
            lastUsedUserAgent: true,
          },
          orderBy: { createdAt: "desc" },
        }),
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

  const tokenItems = extensionTokens.map((t) => ({
    id: t.id,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    expiresAt: t.expiresAt.toISOString(),
    clientKind: t.clientKind,
    lastUsedIp: t.lastUsedIp,
    lastUsedUserAgent: t.lastUsedUserAgent,
  }));

  return NextResponse.json({
    sessions: items,
    sessionCount: items.length,
    maxConcurrentSessions: tenant?.tenant?.maxConcurrentSessions ?? null,
    extensionTokens: tokenItems,
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

  // SELECT tokens before deleteMany so we can invalidate the cache after
  // the DB delete commits (R3 / S-6 sequencing).
  const targets = await withUserTenantRls(session.user.id, async () =>
    prisma.session.findMany({
      where: {
        userId: session.user.id,
        sessionToken: { not: currentToken },
      },
      select: { sessionToken: true },
    }),
  );

  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.session.deleteMany({
      where: {
        userId: session.user.id,
        sessionToken: { not: currentToken },
      },
    }),
  );

  if (targets.length > 0) {
    await invalidateCachedSessions(targets.map((t) => t.sessionToken));
  }

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
