import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import {
  errorResponse,
  handleAuthError,
  notFound,
  rateLimited,
  unauthorized,
} from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// 30/min lets an admin sweep many tokens during incident response without self-DOS.
const revokeLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

// DELETE /api/tenant/operator-tokens/[id] — revoke a token (idempotent on already-revoked)
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.OPERATOR_TOKEN_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const rl = await revokeLimiter.check(`rl:op_token_revoke:${actor.tenantId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const { id } = await params;

  const token = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.operatorToken.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        revokedAt: true,
        subjectUserId: true,
      },
    }),
  );

  // 404 (NOT 403) on cross-tenant lookup miss to avoid token-id enumeration.
  if (!token || token.tenantId !== actor.tenantId) {
    return notFound();
  }

  if (token.revokedAt) {
    return errorResponse(API_ERROR.ALREADY_REVOKED, 409);
  }

  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.operatorToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.OPERATOR_TOKEN_REVOKE,
    targetType: AUDIT_TARGET_TYPE.OPERATOR_TOKEN,
    targetId: id,
    metadata: {
      tokenId: id,
      revokedSubjectUserId: token.subjectUserId,
    },
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
