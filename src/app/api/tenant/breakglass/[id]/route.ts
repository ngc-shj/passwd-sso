import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { assertOrigin } from "@/lib/csrf";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, notFound } from "@/lib/api-response";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

export const runtime = "nodejs";

// DELETE /api/tenant/breakglass/[id] — Revoke a break-glass grant
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const originError = assertOrigin(req);
  if (originError) return originError;

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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
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
  if (grant.requesterId !== userId && actor.role !== "OWNER") {
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
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.PERSONAL_LOG_ACCESS_REVOKE,
    userId,
    tenantId: actor.tenantId,
    targetType: "User",
    targetId: grant.targetUserId,
    metadata: {
      grantId: id,
      requesterId: grant.requesterId,
      targetUserId: grant.targetUserId,
      revokedById: userId,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({ ok: true });
}

export const DELETE = withRequestLog(handleDELETE);
