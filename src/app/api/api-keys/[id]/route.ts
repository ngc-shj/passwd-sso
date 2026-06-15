import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/auth/session/check-auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse } from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";

// DELETE /api/api-keys/[id] — Revoke an API key (session only + step-up)
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await checkAuth(req);
  if (!authed.ok) return authed.response;
  // Step-up parity with POST: API-key revocation is a management op affecting
  // availability, so require the same recent re-auth bar as issuance.
  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;
  const { userId } = authed.auth;

  const { id } = await params;

  const key = await withUserTenantRls(userId, async () =>
    prisma.apiKey.findUnique({
      where: { id },
      select: { id: true, userId: true, name: true, revokedAt: true },
    }),
  );

  if (!key || key.userId !== userId) {
    return errorResponse(API_ERROR.API_KEY_NOT_FOUND);
  }

  if (key.revokedAt) {
    return errorResponse(API_ERROR.API_KEY_ALREADY_REVOKED);
  }

  await withUserTenantRls(userId, async () =>
    prisma.apiKey.update({
      where: { id, userId },
      data: { revokedAt: new Date() },
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.API_KEY_REVOKE,
    targetType: AUDIT_TARGET_TYPE.API_KEY,
    targetId: id,
    metadata: { name: key.name },
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
