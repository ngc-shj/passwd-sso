import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { canRevokeMemberPasskey } from "@/lib/auth/access/tenant-role-hierarchy";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withRequestLog } from "@/lib/http/with-request-log";
import { forbidden, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";

export const runtime = "nodejs";

type Params = { params: Promise<{ userId: string }> };

// GET /api/tenant/members/[userId]/passkeys — a member's passkeys, for an admin
// choosing one to revoke (#974). All of them: passkeys are user-global, so one
// registered under the member's previous tenant signs them in here too
// (`registeredInTenant` false). Same gate as the revoke.
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

  const result = await withBypassRls(prisma, async (tx) => {
    // The member first, active in the actor's tenant: no credential of anyone
    // else is read.
    const member = await tx.tenantMember.findFirst({
      where: { tenantId: actor.tenantId, userId: targetUserId, deactivatedAt: null },
      select: { role: true },
    });
    if (!member) return null;
    if (!canRevokeMemberPasskey(actor.role, member.role)) return { forbidden: true as const };
    const passkeys = await tx.webAuthnCredential.findMany({
      where: { userId: targetUserId },
      select: {
        id: true,
        tenantId: true,
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
    return { passkeys };
  }, BYPASS_GRANT.TENANT_MEMBER_PASSKEY_LIST);
  if (!result) {
    return notFound();
  }
  if ("forbidden" in result) {
    return forbidden();
  }

  return NextResponse.json({
    passkeys: result.passkeys.map(({ tenantId, ...p }) => ({
      ...p,
      registeredInTenant: tenantId === actor.tenantId,
    })),
  });
}

export const GET = withRequestLog(handleGET);
