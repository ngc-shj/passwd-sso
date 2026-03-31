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

  const tokens = await withBypassRls(prisma, () =>
    prisma.mcpAccessToken.findMany({
      where: {
        userId,
        tenantId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        scope: true,
        expiresAt: true,
        createdAt: true,
        mcpClient: {
          select: { name: true, clientId: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json({
    tokens: tokens.map((t) => ({
      id: t.id,
      clientName: t.mcpClient.name,
      clientId: t.mcpClient.clientId,
      scope: t.scope,
      createdAt: t.createdAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
    })),
  });
}

export const GET = withRequestLog(handleGET);
