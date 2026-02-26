import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string; tokenId: string }> };

// DELETE /api/teams/[teamId]/scim-tokens/[tokenId] — Revoke a SCIM token
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, tokenId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.SCIM_MANAGE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const token = await prisma.scimToken.findUnique({
    where: { id: tokenId },
    select: { id: true, orgId: true, revokedAt: true },
  });

  if (!token || token.orgId !== teamId) {
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
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.SCIM_TOKEN_REVOKE,
    userId: session.user.id,
    orgId: teamId,
    targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN,
    targetId: tokenId,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
