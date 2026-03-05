import { NextRequest, NextResponse } from "next/server";
import { authOrToken } from "@/lib/auth-or-token";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

// DELETE /api/api-keys/[id] — Revoke an API key (session or extension token, NOT API key)
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await authOrToken(req);
  if (!authed || authed.type === "scope_insufficient") {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  // API keys cannot manage API keys
  if (authed.type === "api_key") {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  const userId = authed.userId;

  const { id } = await params;

  const key = await withUserTenantRls(userId, async () =>
    prisma.apiKey.findUnique({
      where: { id },
      select: { id: true, userId: true, name: true, revokedAt: true },
    }),
  );

  if (!key || key.userId !== userId) {
    return NextResponse.json({ error: API_ERROR.API_KEY_NOT_FOUND }, { status: 404 });
  }

  if (key.revokedAt) {
    return NextResponse.json({ error: API_ERROR.API_KEY_ALREADY_REVOKED }, { status: 400 });
  }

  await withUserTenantRls(userId, async () =>
    prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.API_KEY_REVOKE,
    userId,
    targetType: AUDIT_TARGET_TYPE.API_KEY,
    targetId: id,
    metadata: { name: key.name },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
