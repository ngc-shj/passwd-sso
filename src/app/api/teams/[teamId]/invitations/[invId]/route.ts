import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; invId: string }> };

// DELETE /api/teams/[teamId]/invitations/[invId] — Cancel invitation
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, invId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const invitation = await withTeamTenantRls(teamId, async () =>
    prisma.teamInvitation.findUnique({
      where: { id: invId },
    }),
  );

  if (!invitation || invitation.teamId !== teamId) {
    return errorResponse(API_ERROR.INVITATION_NOT_FOUND, 404);
  }

  await withTeamTenantRls(teamId, async () =>
    prisma.teamInvitation.delete({ where: { id: invId } }),
  );

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
