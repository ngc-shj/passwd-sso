import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { withTenantRls } from "@/lib/tenant-rls";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized } from "@/lib/api-response";

export const runtime = "nodejs";

// GET /api/tenant/members
// List all tenant members (OWNER/ADMIN only).
async function handleGET(req: NextRequest) {
  void req;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.MEMBER_MANAGE,
    );
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  const members = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantMember.findMany({
      where: { tenantId: actor.tenantId },
      select: {
        id: true,
        userId: true,
        role: true,
        deactivatedAt: true,
        scimManaged: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
  );

  // Count pending resets per member
  const pendingCounts = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.adminVaultReset.groupBy({
      by: ["targetUserId"],
      where: {
        tenantId: actor.tenantId,
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      _count: true,
    }),
  );

  const pendingMap = new Map(
    pendingCounts.map((r) => [r.targetUserId, r._count]),
  );

  const result = members.map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
    role: m.role,
    deactivatedAt: m.deactivatedAt,
    scimManaged: m.scimManaged,
    pendingResets: pendingMap.get(m.userId) ?? 0,
  }));

  return NextResponse.json(result);
}

export const GET = withRequestLog(handleGET);
