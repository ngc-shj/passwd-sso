import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { inviteSchema } from "@/lib/validations";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { INVITATION_STATUS, TEAM_PERMISSION, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { BYPASS_PURPOSE, withBypassRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { TEAM_INVITATION_TTL_MS } from "@/lib/constants/team/invitation";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/invitations — List pending invitations
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE, req);
  } catch (e) {
    return handleAuthError(e);
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
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const result = await parseBody(req, inviteSchema);
  if (!result.ok) return result.response;

  const { email, role } = result.data;

  const teamContextPromise = withTeamTenantRls(teamId, () =>
    Promise.all([
      prisma.teamInvitation.findFirst({
        where: { teamId: teamId, email, status: INVITATION_STATUS.PENDING },
      }),
      prisma.team.findUnique({
        where: { id: teamId },
        select: { tenantId: true },
      }),
    ]),
  );

  // Existing-user lookup must bypass team tenant RLS so guest users from a
  // different home tenant are still recognized as already-added team members.
  // Only id is needed downstream — fetching the full row would expose
  // private-key-encryption material across tenants if the row leaks via logs.
  const existingUserPromise = withBypassRls(prisma, (tx) =>
    tx.user.findUnique({ where: { email }, select: { id: true } }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  const [[existingInv, team], existingUser] = await Promise.all([
    teamContextPromise,
    existingUserPromise,
  ]);

  if (!team) {
    return notFound();
  }

  if (existingInv) {
    return errorResponse(API_ERROR.INVITATION_ALREADY_SENT);
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
        return errorResponse(API_ERROR.ALREADY_A_MEMBER);
      }
      if (existingMember.scimManaged) {
        return errorResponse(API_ERROR.SCIM_MANAGED_MEMBER);
      }
    }
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TEAM_INVITATION_TTL_MS);

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

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.TEAM_MEMBER_INVITE,
    targetType: AUDIT_TARGET_TYPE.TEAM_INVITATION,
    targetId: invitation.id,
    metadata: { email, role },
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
    { status: 201, headers: { ...NO_STORE_HEADERS } }
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
