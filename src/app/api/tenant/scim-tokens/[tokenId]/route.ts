import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";

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
    return handleAuthError(err);
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

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.SCIM_TOKEN_REVOKE,
    targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN,
    targetId: tokenId,
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
