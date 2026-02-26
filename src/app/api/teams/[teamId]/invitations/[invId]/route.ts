import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string; invId: string }> };

// DELETE /api/teams/[teamId]/invitations/[invId] — Cancel invitation
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId, invId } = await params;

  try {
    await requireTeamPermission(session.user.id, orgId, TEAM_PERMISSION.MEMBER_INVITE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const invitation = await prisma.orgInvitation.findUnique({
    where: { id: invId },
  });

  if (!invitation || invitation.orgId !== orgId) {
    return NextResponse.json(
      { error: API_ERROR.INVITATION_NOT_FOUND },
      { status: 404 }
    );
  }

  await prisma.orgInvitation.delete({ where: { id: invId } });

  return NextResponse.json({ success: true });
}
