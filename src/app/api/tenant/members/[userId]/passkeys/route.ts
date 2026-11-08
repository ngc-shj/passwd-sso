import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, isTenantRoleAbove } from "@/lib/auth/access/tenant-auth";
import { withTenantRls } from "@/lib/tenant-rls";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withRequestLog } from "@/lib/http/with-request-log";
import { forbidden, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";

export const runtime = "nodejs";

type Params = { params: Promise<{ userId: string }> };

// GET /api/tenant/members/[userId]/passkeys — the member's passkeys registered
// under this tenant, for an admin choosing one to revoke (#974). Same gate as
// the revoke: MEMBER_MANAGE and a role strictly above the member's.
async function handleGET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId: targetUserId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (err) {
    return handleAuthError(err);
  }
  if (targetUserId === session.user.id) {
    return forbidden();
  }

  const result = await withTenantRls(prisma, actor.tenantId, async (tx) => {
    const member = await tx.tenantMember.findFirst({
      where: { tenantId: actor.tenantId, userId: targetUserId, deactivatedAt: null },
      select: { role: true },
    });
    if (!member) return null;
    const passkeys = await tx.webAuthnCredential.findMany({
      where: { userId: targetUserId, tenantId: actor.tenantId },
      select: {
        id: true,
        nickname: true,
        deviceType: true,
        backedUp: true,
        registeredDevice: true,
        lastUsedDevice: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return { role: member.role, passkeys };
  });
  if (!result) {
    return notFound();
  }
  if (!isTenantRoleAbove(actor.role, result.role)) {
    return forbidden();
  }

  return NextResponse.json({ passkeys: result.passkeys });
}

export const GET = withRequestLog(handleGET);
