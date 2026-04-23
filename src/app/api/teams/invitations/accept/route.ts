import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, unauthorized } from "@/lib/api-response";
import { INVITATION_STATUS } from "@/lib/constants";
import { withUserTenantRls, withTeamTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { parseBody } from "@/lib/parse-body";
import { invitationAcceptSchema } from "@/lib/validations";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const acceptLimiter = createRateLimiter({ windowMs: 5 * MS_PER_MINUTE, max: 10 });

// POST /api/teams/invitations/accept — Accept an invitation by token
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return unauthorized();
  }

  const rl = await acceptLimiter.check(`rl:invite_accept:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, invitationAcceptSchema);
  if (!result.ok) return result.response;

  const { token } = result.data;

  // Invitation lookup must bypass RLS: the invitee is not yet in the team's tenant
  const invitation = await withBypassRls(prisma, async () =>
    prisma.teamInvitation.findUnique({
      where: { token },
      include: { team: { select: { id: true, name: true, slug: true, tenantId: true } } },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!invitation) {
    return errorResponse(API_ERROR.INVALID_INVITATION, 404);
  }

  if (invitation.status !== INVITATION_STATUS.PENDING) {
    return errorResponse(API_ERROR.INVITATION_ALREADY_USED, 410);
  }

  if (invitation.expiresAt < new Date()) {
    await withTeamTenantRls(invitation.teamId, async () =>
      prisma.teamInvitation.update({
        where: { id: invitation.id },
        data: { status: INVITATION_STATUS.EXPIRED },
      }),
    );
    return errorResponse(API_ERROR.INVITATION_EXPIRED, 410);
  }

  // Verify the invitation email matches the authenticated user.
  // Known limitation: uses case-insensitive comparison only.
  // Gmail alias normalization (+tag removal, dot removal) is not handled.
  if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) {
    return errorResponse(API_ERROR.INVITATION_WRONG_EMAIL, 403);
  }

  // Check if already a member (active or deactivated) — team tenant context
  const existingMember = await withTeamTenantRls(invitation.teamId, async () =>
    prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: invitation.teamId,
          userId: session.user.id,
        },
      },
      select: { deactivatedAt: true, scimManaged: true },
    }),
  );

  if (existingMember) {
    // Active member → already a member
    if (existingMember.deactivatedAt === null) {
      await withTeamTenantRls(invitation.teamId, async () =>
        prisma.teamInvitation.update({
          where: { id: invitation.id },
          data: { status: INVITATION_STATUS.ACCEPTED },
        }),
      );
      return NextResponse.json({
        team: invitation.team,
        alreadyMember: true,
      });
    }

    // Deactivated + scimManaged → reject, IdP should re-activate
    if (existingMember.scimManaged) {
      return errorResponse(API_ERROR.SCIM_MANAGED_MEMBER, 409);
    }

    // Deactivated + !scimManaged → re-activate via invitation
  }

  // Team is always E2E-enabled.
  // Check if the user has an ECDH public key (vault set up).
  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { ecdhPublicKey: true },
    }),
  );
  const vaultSetupRequired = !user?.ecdhPublicKey;

  // Create membership (or re-activate if previously deactivated) and mark invitation as accepted.
  // keyDistributed starts as false (admin must distribute team key).
  // Use team tenant context: team_members and team_invitations belong to the team's tenant.
  await withTeamTenantRls(invitation.teamId, async () =>
    prisma.$transaction([
      prisma.teamMember.upsert({
        where: {
          teamId_userId: {
            teamId: invitation.teamId,
            userId: session.user.id,
          },
        },
        create: {
          teamId: invitation.teamId,
          userId: session.user.id,
          tenantId: invitation.team.tenantId,
          role: invitation.role,
          keyDistributed: false,
        },
        update: {
          role: invitation.role,
          keyDistributed: false,
          deactivatedAt: null,
          scimManaged: false,
        },
      }),
      prisma.teamInvitation.update({
        where: { id: invitation.id },
        data: { status: INVITATION_STATUS.ACCEPTED },
      }),
    ]),
  );

  return NextResponse.json({
    team: invitation.team,
    role: invitation.role,
    alreadyMember: false,
    needsKeyDistribution: true,
    vaultSetupRequired,
  });
}

export const POST = withRequestLog(handlePOST);
