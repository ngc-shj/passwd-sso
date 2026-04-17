import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { requireTenantPermission } from "@/lib/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ id: string; tokenId: string }> };

export const runtime = "nodejs";

// DELETE /api/tenant/service-accounts/[id]/tokens/[tokenId] — Revoke a service account token
async function handleDELETE(req: NextRequest, { params }: Params) {
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

  const { id, tokenId } = await params;

  const sa = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.findUnique({
      where: { id },
      select: { id: true, tenantId: true },
    }),
  );

  if (!sa || sa.tenantId !== actor.tenantId) {
    return notFound();
  }

  const token = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccountToken.findUnique({
      where: { id: tokenId },
      select: { id: true, serviceAccountId: true, tenantId: true, revokedAt: true },
    }),
  );

  if (!token || token.serviceAccountId !== id || token.tenantId !== actor.tenantId) {
    return notFound();
  }

  if (token.revokedAt) {
    return errorResponse(API_ERROR.SA_TOKEN_ALREADY_REVOKED, 409);
  }

  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccountToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    }),
  );

  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_REVOKE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT_TOKEN,
    targetId: tokenId,
    metadata: { serviceAccountId: id },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
