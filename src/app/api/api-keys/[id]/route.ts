import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/check-auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/api-response";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";

// DELETE /api/api-keys/[id] — Revoke an API key (session or extension token, NOT API key)
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await checkAuth(req, { allowTokens: true });
  if (!authed.ok) return authed.response;
  // Only session and extension token can manage API keys
  if (authed.auth.type === "api_key" || authed.auth.type === "mcp_token") {
    return unauthorized();
  }
  const { userId } = authed.auth;

  const { id } = await params;

  const key = await withUserTenantRls(userId, async () =>
    prisma.apiKey.findUnique({
      where: { id },
      select: { id: true, userId: true, name: true, revokedAt: true },
    }),
  );

  if (!key || key.userId !== userId) {
    return errorResponse(API_ERROR.API_KEY_NOT_FOUND, 404);
  }

  if (key.revokedAt) {
    return errorResponse(API_ERROR.API_KEY_ALREADY_REVOKED, 400);
  }

  await withUserTenantRls(userId, async () =>
    prisma.apiKey.update({
      where: { id },
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
