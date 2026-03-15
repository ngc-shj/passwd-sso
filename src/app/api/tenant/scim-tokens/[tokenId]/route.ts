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
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ tokenId: string }> };

export const runtime = "nodejs";

// DELETE /api/tenant/scim-tokens/[tokenId] — Revoke a SCIM token
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SCIM_MANAGE,
    );
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  const { tokenId } = await params;

  const token = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.scimToken.findUnique({
      where: { id: tokenId },
      select: { id: true, tenantId: true, revokedAt: true },
    }),
  );

  if (!token || token.tenantId !== actor.tenantId) {
    return notFound();
  }

  if (token.revokedAt) {
    return errorResponse(API_ERROR.ALREADY_REVOKED, 409);
  }

  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.scimToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SCIM_TOKEN_REVOKE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN,
    targetId: tokenId,
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.SCIM_TOKEN_REVOKE,
    tenantId: actor.tenantId,
    timestamp: new Date().toISOString(),
    data: { tokenId },
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
