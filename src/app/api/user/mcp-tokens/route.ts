import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { unauthorized, rateLimited, errorResponse } from "@/lib/api-response";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";
import { evictDelegationRedisKeys } from "@/lib/auth/delegation";

const revokeAllLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return errorResponse(API_ERROR.NO_TENANT, 403);
  }

  const clients = await withBypassRls(prisma, () =>
    prisma.mcpClient.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        clientId: true,
        name: true,
        isDcr: true,
        allowedScopes: true,
        createdAt: true,
        accessTokens: {
          where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { id: true, scope: true, createdAt: true, expiresAt: true, lastUsedAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  return NextResponse.json({
    clients: clients.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      isDcr: c.isDcr,
      allowedScopes: c.allowedScopes,
      clientCreatedAt: c.createdAt.toISOString(),
      connection: c.accessTokens[0]
        ? {
            tokenId: c.accessTokens[0].id,
            scope: c.accessTokens[0].scope,
            createdAt: c.accessTokens[0].createdAt.toISOString(),
            expiresAt: c.accessTokens[0].expiresAt.toISOString(),
            lastUsedAt: c.accessTokens[0].lastUsedAt?.toISOString() ?? null,
          }
        : null,
    })),
  });
}

async function handleDELETE(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const rl = await revokeAllLimiter.check(`rl:mcp_revoke_all:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return errorResponse(API_ERROR.NO_TENANT, 403);
  }

  const now = new Date();

  const { revokedCount, delegationSessionIds } = await withBypassRls(
    prisma,
    async () => {
      const result = await prisma.$transaction(async (tx) => {
        // 1. Find all active tokens for this user (inside transaction for consistency)
        const activeTokens = await tx.mcpAccessToken.findMany({
          where: { userId, tenantId, revokedAt: null, expiresAt: { gt: now } },
          select: { id: true },
        });

        if (activeTokens.length === 0) {
          return { revokedCount: 0, delegationSessionIds: [] as string[] };
        }

        const tokenIds = activeTokens.map((t) => t.id);

        // 2. Revoke all access tokens
        await tx.mcpAccessToken.updateMany({
          where: { id: { in: tokenIds }, revokedAt: null },
          data: { revokedAt: now },
        });

        // 3. Revoke refresh token families
        const refreshTokens = await tx.mcpRefreshToken.findMany({
          where: { accessTokenId: { in: tokenIds } },
          select: { familyId: true },
        });
        const familyIds = [
          ...new Set(refreshTokens.map((rt) => rt.familyId)),
        ];
        if (familyIds.length > 0) {
          await tx.mcpRefreshToken.updateMany({
            where: { familyId: { in: familyIds }, revokedAt: null },
            data: { revokedAt: now },
          });

          // Also revoke any sibling access tokens in the same families
          const relatedRefresh = await tx.mcpRefreshToken.findMany({
            where: { familyId: { in: familyIds } },
            select: { accessTokenId: true },
          });
          const relatedIds = [
            ...new Set(relatedRefresh.map((r) => r.accessTokenId)),
          ];
          if (relatedIds.length > 0) {
            await tx.mcpAccessToken.updateMany({
              where: { id: { in: relatedIds }, userId, tenantId, revokedAt: null },
              data: { revokedAt: now },
            });
          }
        }

        // 3. Revoke delegation sessions (with userId for defense-in-depth)
        const sessions = await tx.delegationSession.findMany({
          where: {
            mcpTokenId: { in: tokenIds },
            userId,
            revokedAt: null,
          },
          select: { id: true },
        });
        if (sessions.length > 0) {
          await tx.delegationSession.updateMany({
            where: {
              mcpTokenId: { in: tokenIds },
              userId,
              revokedAt: null,
            },
            data: { revokedAt: now },
          });
        }

        // 4. Single summary audit entry
        await tx.auditLog.create({
          data: {
            userId,
            tenantId,
            action: AUDIT_ACTION.MCP_CONNECTION_REVOKE_ALL,
            scope: AUDIT_SCOPE.PERSONAL,
            targetType: "McpAccessToken",
            metadata: { revokedCount: tokenIds.length },
          },
        });

        return {
          revokedCount: tokenIds.length,
          delegationSessionIds: sessions.map((s) => s.id),
        };
      });

      return result;
    },
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );

  // Post-commit: evict Redis delegation keys (best-effort)
  for (const sessionId of delegationSessionIds) {
    evictDelegationRedisKeys(userId, sessionId).catch(() => {});
  }

  return NextResponse.json({ revokedCount });
}

export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
