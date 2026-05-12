import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { transition, AR_STATUS, AR_ACTOR } from "@/lib/access-request/access-request-state";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, rateLimited, unauthorized } from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";

type Params = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

const denyLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// POST /api/tenant/access-requests/[id]/deny — Deny an access request
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const rl = await denyLimiter.check(`rl:access_request_deny:${actor.tenantId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const { id: requestId } = await params;

  // Verify the access request exists and belongs to this tenant
  const request = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.accessRequest.findUnique({
      where: { id: requestId },
      select: { id: true, tenantId: true, serviceAccountId: true },
    }),
  );

  if (!request || request.tenantId !== actor.tenantId) {
    return notFound();
  }

  // Optimistic lock: only update if still PENDING and belongs to this tenant
  const transitionResult = await withTenantRls(prisma, actor.tenantId, async () =>
    transition({
      db: prisma,
      where: { id: requestId, tenantId: actor.tenantId },
      to: AR_STATUS.DENIED,
      actor: AR_ACTOR.ADMIN,
      extraData: { approvedById: session.user.id, approvedAt: new Date() },
    }),
  );

  if (!transitionResult.ok) {
    return errorResponse(API_ERROR.CONFLICT, 409);
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.ACCESS_REQUEST_DENY,
    targetType: AUDIT_TARGET_TYPE.ACCESS_REQUEST,
    targetId: requestId,
    metadata: { serviceAccountId: request.serviceAccountId },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
