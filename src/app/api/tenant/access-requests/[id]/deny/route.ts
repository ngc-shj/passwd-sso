import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { dispatchTenantWebhook } from "@/lib/webhook-dispatcher";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized, notFound, rateLimited } from "@/lib/api-response";
import { createRateLimiter } from "@/lib/rate-limit";

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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
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
  const updated = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.accessRequest.updateMany({
      where: { id: requestId, status: "PENDING", tenantId: actor.tenantId },
      data: { status: "DENIED", approvedById: session.user.id, approvedAt: new Date() },
    }),
  );

  if (updated.count === 0) {
    return NextResponse.json(
      { error: API_ERROR.CONFLICT },
      { status: 409 },
    );
  }

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.ACCESS_REQUEST_DENY,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.ACCESS_REQUEST,
    targetId: requestId,
    metadata: { serviceAccountId: request.serviceAccountId },
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.ACCESS_REQUEST_DENY,
    tenantId: actor.tenantId,
    timestamp: new Date().toISOString(),
    data: { accessRequestId: requestId, serviceAccountId: request.serviceAccountId },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
