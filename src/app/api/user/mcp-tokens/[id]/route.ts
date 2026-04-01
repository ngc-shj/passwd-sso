import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { unauthorized } from "@/lib/api-response";
import { withRequestLog } from "@/lib/with-request-log";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";
import { evictDelegationRedisKeys } from "@/lib/delegation";

async function handleDELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return NextResponse.json({ error: "No tenant" }, { status: 403 });
  }
  const { id } = await params;

  const result = await withBypassRls(prisma, async () => {
    const token = await prisma.mcpAccessToken.findFirst({
      where: { id, userId, tenantId, revokedAt: null },
      select: { id: true },
    });
    if (!token) return null;

    const now = new Date();

    const revokedDelegationSessionIds = await prisma.$transaction(async (tx) => {
      await tx.mcpAccessToken.update({
        where: { id },
        data: { revokedAt: now },
      });

      const refreshTokens = await tx.mcpRefreshToken.findMany({
        where: { accessTokenId: id },
        select: { familyId: true },
      });

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
            where: { id: { in: relatedIds }, revokedAt: null },
            data: { revokedAt: now },
          });
        }
      }

      const sessions = await tx.delegationSession.findMany({
        where: { mcpTokenId: id, revokedAt: null },
        select: { id: true },
      });
      if (sessions.length > 0) {
        await tx.delegationSession.updateMany({
          where: { mcpTokenId: id, revokedAt: null },
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

    // Evict Redis delegation keys best-effort (after transaction commit)
    for (const sessionId of revokedDelegationSessionIds) {
      evictDelegationRedisKeys(userId, sessionId).catch(() => {});
    }

    return token;
  });

  if (!result) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}

export const DELETE = withRequestLog(handleDELETE);
