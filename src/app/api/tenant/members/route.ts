import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { withTenantRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { fetchUserDisplayMap } from "@/lib/audit/audit-user-lookup";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";

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
    return handleAuthError(err);
  }

  const [members, pendingCounts] = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    Promise.all([
      tx.tenantMember.findMany({
        where: { tenantId: actor.tenantId },
        select: {
          id: true,
          userId: true,
          role: true,
          deactivatedAt: true,
          scimManaged: true,
          // Identity is NOT read through the relation. `users_tenant_isolation`
          // filters a member whose `users` row lives in another tenant — an
          // ordinary outcome of a realignment — and because the relation is
          // REQUIRED, that filtered row took the whole member list down rather
          // than just its own entry. Hydrated below, outside this context.
        },
        orderBy: { createdAt: "asc" },
      }),
      // Includes pending_approval AND approved (not yet executed) per dual-approval plan
      tx.adminVaultReset.groupBy({
        by: ["targetUserId"],
        where: {
          tenantId: actor.tenantId,
          executedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        _count: true,
      }),
    ]),
  );

  const pendingMap = new Map(
    pendingCounts.map((r) => [r.targetUserId, r._count]),
  );

  const userById = await fetchUserDisplayMap(
    members.map((m) => m.userId),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );

  const result = members.map((m) => ({
    id: m.id,
    userId: m.userId,
    // Explicit nulls, not a silent omission: a member the hydration could not
    // resolve must be distinguishable from one who simply has no name.
    name: userById.get(m.userId)?.name ?? null,
    email: userById.get(m.userId)?.email ?? null,
    image: userById.get(m.userId)?.image ?? null,
    role: m.role,
    deactivatedAt: m.deactivatedAt,
    scimManaged: m.scimManaged,
    pendingResets: pendingMap.get(m.userId) ?? 0,
  }));

  return NextResponse.json(result);
}

export const GET = withRequestLog(handleGET);
