import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { unauthorized, notFound, rateLimited, errorResponse } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { evictDelegationRedisKeys } from "@/lib/auth/access/delegation";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

// Self-scoped, so there is no cross-user oracle here — the cap is on the
// per-call write and audit-insert fan-out, matching sessions/[id].
const revokeLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 10 });

async function handleDELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const rl = await revokeLimiter.check(`rl:mcp_revoke:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return errorResponse(API_ERROR.NO_TENANT);
  }
  const { id } = await params;

  const result = await withBypassRls(prisma, async (tx) => {
    const token = await tx.mcpAccessToken.findFirst({
      where: { id, userId, tenantId, revokedAt: null },
      select: { id: true },
    });
    if (!token) return null;

    const now = new Date();

    const revokedDelegationSessionIds = await prisma.$transaction(async (tx) => {
      await tx.mcpAccessToken.update({
        where: { id, userId, tenantId },
        data: { revokedAt: now },
      });

      const refreshTokens = await tx.mcpRefreshToken.findMany({
        where: { accessTokenId: id },
        select: { familyId: true },
      });

      // Every access token reachable from the revoked one through its refresh
      // families. Delegation sessions are bound to whichever access-token row
      // was current when they were created, so a session created before a
      // rotation names a sibling — revoking only `id` would leave it live.
      const revokedTokenIds = [id];

      const familyIds = [...new Set(refreshTokens.map((rt) => rt.familyId))];
      if (familyIds.length > 0) {
        await tx.mcpRefreshToken.updateMany({
          where: { familyId: { in: familyIds }, revokedAt: null },
          data: { revokedAt: now },
        });

        const relatedRefresh = await tx.mcpRefreshToken.findMany({
          where: { familyId: { in: familyIds } },
          select: { accessTokenId: true },
        });
        const relatedIds = [...new Set(relatedRefresh.map((r) => r.accessTokenId))];
        if (relatedIds.length > 0) {
          await tx.mcpAccessToken.updateMany({
            // Scoped by owner like the collection route's equivalent statement.
            // familyId is server-minted and never spans principals, so this is
            // defense-in-depth — but it is the only write here whose reach is
            // otherwise decided by data rather than by the caller, and it runs
            // with RLS off.
            where: { id: { in: relatedIds }, userId, tenantId, revokedAt: null },
            data: { revokedAt: now },
          });
          revokedTokenIds.push(...relatedIds.filter((tokenId) => tokenId !== id));
        }
      }

      const sessions = await tx.delegationSession.findMany({
        where: { mcpTokenId: { in: revokedTokenIds }, userId, revokedAt: null },
        select: { id: true },
      });
      if (sessions.length > 0) {
        await tx.delegationSession.updateMany({
          where: { mcpTokenId: { in: revokedTokenIds }, userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      // Audit: MCP connection revoke
      await tx.auditLog.create({
        data: {
          userId,
          tenantId,
          action: AUDIT_ACTION.MCP_CONNECTION_REVOKE,
          scope: AUDIT_SCOPE.PERSONAL,
          targetType: "McpAccessToken",
          targetId: id,
        },
      });

      // Audit: individual delegation session revocations
      for (const ds of sessions) {
        await tx.auditLog.create({
          data: {
            userId,
            tenantId,
            action: AUDIT_ACTION.DELEGATION_REVOKE,
            scope: AUDIT_SCOPE.PERSONAL,
            targetType: "DelegationSession",
            targetId: ds.id,
          },
        });
      }

      return sessions.map((s) => s.id);
    });

    return { token, revokedDelegationSessionIds };
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!result) {
    return notFound();
  }

  // Best-effort, and deliberately outside the callback: launching it inside
  // would start the eviction before the transaction commits, which the sibling
  // collection route already avoids by returning the ids first.
  for (const sessionId of result.revokedDelegationSessionIds) {
    evictDelegationRedisKeys(userId, sessionId).catch(() => {});
  }

  return new NextResponse(null, { status: 204 });
}

export const DELETE = withRequestLog(handleDELETE);
