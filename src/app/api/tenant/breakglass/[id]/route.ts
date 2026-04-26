import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { AUDIT_ACTION, TENANT_ROLE } from "@/lib/constants";

export const runtime = "nodejs";

// DELETE /api/tenant/breakglass/[id] — Revoke a break-glass grant
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const userId = session.user.id;
  const { id } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(
      userId,
      TENANT_PERMISSION.BREAKGLASS_REQUEST,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  // Find the grant within tenant RLS scope
  const grant = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.personalLogAccessGrant.findFirst({
      where: {
        id,
        tenantId: actor.tenantId,
      },
    }),
  );

  if (!grant) {
    return notFound();
  }

  // Only the requester or an OWNER can revoke
  if (grant.requesterId !== userId && actor.role !== TENANT_ROLE.OWNER) {
    return errorResponse(API_ERROR.FORBIDDEN, 403);
  }

  const now = new Date();

  // Must be active: not expired, not revoked
  if (grant.revokedAt) {
    return errorResponse(API_ERROR.CONFLICT, 409, {
      details: { status: "already_revoked" },
    });
  }
  if (grant.expiresAt <= now) {
    return errorResponse(API_ERROR.CONFLICT, 409, {
      details: { status: "already_expired" },
    });
  }

  // Atomic revoke
  const result = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.personalLogAccessGrant.updateMany({
      where: {
        id,
        tenantId: actor.tenantId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    }),
  );

  if (result.count === 0) {
    return errorResponse(API_ERROR.CONFLICT, 409);
  }

  // Audit log (non-blocking)
  await logAuditAsync({
    ...tenantAuditBase(req, userId, actor.tenantId),
    action: AUDIT_ACTION.PERSONAL_LOG_ACCESS_REVOKE,
    targetType: "User",
    targetId: grant.targetUserId,
    metadata: {
      grantId: id,
      requesterId: grant.requesterId,
      targetUserId: grant.targetUserId,
      revokedById: userId,
    },
  });

  return NextResponse.json({ ok: true });
}

export const DELETE = withRequestLog(handleDELETE);
