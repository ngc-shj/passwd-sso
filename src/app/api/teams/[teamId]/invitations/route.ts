import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { inviteSchema } from "@/lib/validations";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { INVITATION_STATUS, TEAM_PERMISSION, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/invitations — List pending invitations
async function handleGET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const invitations = await withTeamTenantRls(teamId, async () =>
    prisma.teamInvitation.findMany({
      where: { teamId: teamId, status: INVITATION_STATUS.PENDING },
      include: {
        invitedBy: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json(
    invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      status: inv.status,
      expiresAt: inv.expiresAt,
      invitedBy: inv.invitedBy,
      createdAt: inv.createdAt,
    }))
  );
}

// POST /api/teams/[teamId]/invitations — Create invitation
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const result = await parseBody(req, inviteSchema);
  if (!result.ok) return result.response;

  const { email, role } = result.data;

  // Parallelize independent lookups: user, pending invitation, team
  const [existingUser, existingInv, team] = await withTeamTenantRls(
    teamId,
    () =>
      Promise.all([
        prisma.user.findUnique({ where: { email } }),
        prisma.teamInvitation.findFirst({
          where: { teamId: teamId, email, status: INVITATION_STATUS.PENDING },
        }),
        prisma.team.findUnique({
          where: { id: teamId },
          select: { tenantId: true },
        }),
      ]),
  );

  if (!team) {
    return notFound();
  }

  if (existingInv) {
    return errorResponse(API_ERROR.INVITATION_ALREADY_SENT, 409);
  }

  if (existingUser) {
    const existingMember = await withTeamTenantRls(teamId, async () =>
      prisma.teamMember.findUnique({
        where: {
          teamId_userId: { teamId: teamId, userId: existingUser.id },
        },
      }),
    );
    if (existingMember) {
      if (existingMember.deactivatedAt === null) {
        return errorResponse(API_ERROR.ALREADY_A_MEMBER, 409);
      }
      if (existingMember.scimManaged) {
        return errorResponse(API_ERROR.SCIM_MANAGED_MEMBER, 409);
      }
    }
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const invitation = await withTeamTenantRls(teamId, async () =>
    prisma.teamInvitation.create({
      data: {
        teamId: teamId,
        tenantId: team.tenantId,
        email,
        role,
        token,
        expiresAt,
        invitedById: session.user.id,
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.TEAM_MEMBER_INVITE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_INVITATION,
    targetId: invitation.id,
    metadata: { email, role },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    },
    { status: 201 }
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
