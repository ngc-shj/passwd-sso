import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string; tokenId: string }> };

// DELETE /api/orgs/[orgId]/scim-tokens/[tokenId] — Revoke a SCIM token
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, tokenId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.SCIM_MANAGE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const token = await prisma.scimToken.findUnique({
    where: { id: tokenId },
    select: { id: true, orgId: true, revokedAt: true },
  });

  if (!token || token.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (token.revokedAt) {
    return NextResponse.json({ error: API_ERROR.ALREADY_REVOKED }, { status: 409 });
  }

  await prisma.scimToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.SCIM_TOKEN_REVOKE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN,
    targetId: tokenId,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
