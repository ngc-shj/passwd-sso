import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { unauthorized } from "@/lib/api-response";
import { withRequestLog } from "@/lib/with-request-log";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { resolveUserTenantId } from "@/lib/tenant-context";

async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return NextResponse.json({ error: "No tenant" }, { status: 403 });
  }

  const clients = await withBypassRls(prisma, () =>
    prisma.mcpClient.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        clientId: true,
        name: true,
        isDcr: true,
        accessTokens: {
          where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { id: true, scope: true, createdAt: true, expiresAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    }),
  );

  return NextResponse.json({
    clients: clients.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      isDcr: c.isDcr,
      connection: c.accessTokens[0]
        ? {
            tokenId: c.accessTokens[0].id,
            scope: c.accessTokens[0].scope,
            createdAt: c.accessTokens[0].createdAt.toISOString(),
            expiresAt: c.accessTokens[0].expiresAt.toISOString(),
          }
        : null,
    })),
  });
}

export const GET = withRequestLog(handleGET);
