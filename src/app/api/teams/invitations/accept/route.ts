import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { membershipConflictResponse } from "@/lib/http/lock-conflict-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { INVITATION_STATUS, TEAM_PERMISSION } from "@/lib/constants";
import { withUserTenantRls, withTeamTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { parseBody } from "@/lib/http/parse-body";
import { invitationAcceptSchema } from "@/lib/validations";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { createLockBudget, lockTeamsAgainstRotation } from "@/lib/team/team-key-rotation-lock";
import { departedSince, isMembershipLockConflict, lockTenantRows } from "@/lib/team/tenant-row-lock";
import { activeTeamRole, hasTeamPermission } from "@/lib/auth/access/team-auth";

const ACCEPT_OUTCOME = {
  ACCEPTED: "accepted",
  ALREADY_MEMBER: "already_member",
  ALREADY_USED: "already_used",
  DEPARTED: "departed",
} as const;

const acceptLimiter = createRateLimiter({
  windowMs: 5 * MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

/** SCIM admitted the invitee, pending approval, inside the locked transaction (C6). */
class ScimApprovalPendingRaceError extends Error {}
class ScimManagedMemberRaceError extends Error {}

// POST /api/teams/invitations/accept — Accept an invitation by token
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return unauthorized();
  }

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: acceptLimiter,
    key: `rl:invite_accept:${session.user.id}`,
    scope: "teams.invitation_accept_token",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  const result = await parseBody(req, invitationAcceptSchema);
  if (!result.ok) return result.response;

  const { token } = result.data;

  // Invitation lookup must bypass RLS: the invitee is not yet in the team's tenant
  const invitation = await withBypassRls(prisma, async (tx) =>
    tx.teamInvitation.findUnique({
      where: { token },
      include: { team: { select: { id: true, name: true, slug: true, tenantId: true } } },
    }),
  BYPASS_GRANT.TEAM_INVITATION_ACCEPT);

  if (!invitation) {
    return errorResponse(API_ERROR.INVALID_INVITATION);
  }

  if (invitation.status !== INVITATION_STATUS.PENDING) {
    return errorResponse(API_ERROR.INVITATION_ALREADY_USED);
  }

  if (invitation.expiresAt < new Date()) {
    await withTeamTenantRls(invitation.teamId, async () =>
      prisma.teamInvitation.updateMany({
        where: { id: invitation.id, teamId: invitation.teamId, status: INVITATION_STATUS.PENDING },
        data: { status: INVITATION_STATUS.EXPIRED },
      }),
    );
    return errorResponse(API_ERROR.INVITATION_EXPIRED);
  }

  // Verify the invitation email matches the authenticated user.
  // Known limitation: uses case-insensitive comparison only.
  // Gmail alias normalization (+tag removal, dot removal) is not handled.
  if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) {
    return errorResponse(API_ERROR.INVITATION_WRONG_EMAIL);
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
      select: { deactivatedAt: true, scimManaged: true, deactivatedByTenant: true, scimApprovalPending: true },
    }),
  );

  if (existingMember) {
    // Active member → already a member
    if (existingMember.deactivatedAt === null) {
      await withTeamTenantRls(invitation.teamId, async () =>
        prisma.teamInvitation.updateMany({
          where: { id: invitation.id, teamId: invitation.teamId, status: INVITATION_STATUS.PENDING },
          data: { status: INVITATION_STATUS.ACCEPTED },
        }),
      );
      return NextResponse.json({
        team: invitation.team,
        alreadyMember: true,
      });
    }

    // Waiting on a team OWNER/ADMIN's approval (scim-team-admission-approval,
    // C6) — checked before SCIM_MANAGED_MEMBER below, which a pending row
    // would otherwise also trip (it is always scimManaged too). The race
    // where SCIM creates the pending row after this read is re-checked inside
    // the locked transaction below.
    if (existingMember.scimApprovalPending) {
      return errorResponse(API_ERROR.SCIM_APPROVAL_PENDING);
    }

    // Deactivated by the IdP's group removal (scimManaged, no tenant
    // departure marker) → reject, the IdP should re-add. A membership ended
    // by the user's departure from the tenant is re-invitable.
    if (existingMember.scimManaged && !existingMember.deactivatedByTenant) {
      return errorResponse(API_ERROR.SCIM_MANAGED_MEMBER);
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
  //
  // Admission is decided here, under the lock order of tenant-row-lock.ts:
  // the invitee's and the inviter's tenant rows (FOR SHARE), then the team,
  // then the invitation. An invitation issued before either of them left the
  // tenant (or before a SCIM DELETE of either) does not admit; the refusal
  // commits the invitation as EXPIRED, so it is returned, not thrown.
  let outcome: (typeof ACCEPT_OUTCOME)[keyof typeof ACCEPT_OUTCOME];
  try {
    outcome = await withTeamTenantRls(
      invitation.teamId,
      async (_tenantId, tx) => {
        const budget = createLockBudget();
        const rows = await lockTenantRows(
          tx,
          invitation.team.tenantId,
          [session.user.id, invitation.invitedById],
          "share",
          budget,
        );
        await lockTeamsAgainstRotation(tx, [invitation.teamId], budget);

        // Claim the invitation atomically: re-assert PENDING + not-expired in the
        // write so two concurrent accepts (or an accept straddling expiry) cannot
        // both succeed. The pre-checks above are the fast path; this is the guard.
        // A departure expires the invitations its user issued; the claim then
        // matches nothing.
        const claim = await tx.teamInvitation.updateMany({
          where: {
            id: invitation.id,
            teamId: invitation.teamId,
            invitedById: invitation.invitedById,
            status: INVITATION_STATUS.PENDING,
            expiresAt: { gt: new Date() },
          },
          data: { status: INVITATION_STATUS.ACCEPTED },
        });
        if (claim.count === 0) return ACCEPT_OUTCOME.ALREADY_USED;

        // An invitation speaks for its inviter: refused when the invitee or
        // the inviter left the tenant since it was issued, or the inviter is
        // no longer a member entitled to invite (removed or demoted since).
        const inviterRole = await activeTeamRole(tx, invitation.teamId, invitation.invitedById);
        if (
          departedSince(rows.get(session.user.id), invitation.createdAt) ||
          departedSince(rows.get(invitation.invitedById), invitation.createdAt) ||
          !inviterRole ||
          !hasTeamPermission(inviterRole, TEAM_PERMISSION.MEMBER_INVITE)
        ) {
          await tx.teamInvitation.update({
            where: { id: invitation.id },
            data: { status: INVITATION_STATUS.EXPIRED },
          });
          return ACCEPT_OUTCOME.DEPARTED;
        }

        // Active since the pre-check (another accept, members POST): nothing
        // to re-admit, and its keys must stay.
        const current = await tx.teamMember.findUnique({
          where: { teamId_userId: { teamId: invitation.teamId, userId: session.user.id } },
          select: { deactivatedAt: true, scimApprovalPending: true, scimManaged: true, deactivatedByTenant: true },
        });
        if (current && current.deactivatedAt === null) return ACCEPT_OUTCOME.ALREADY_MEMBER;
        // SCIM admitted this user, pending approval, after the pre-check above
        // read no row (scim-team-admission-approval, C6). Thrown, not
        // returned: the claim above must roll back too, so the invitation
        // stays PENDING rather than being spent on a refusal.
        if (current?.scimApprovalPending) throw new ScimApprovalPendingRaceError();
        // Likewise a SCIM group removal since the pre-check (it unmarks a
        // departed row): the IdP removed this membership, so an invitation
        // must not bring it back.
        if (current?.scimManaged && !current.deactivatedByTenant) throw new ScimManagedMemberRaceError();

        await tx.teamMember.upsert({
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
            deactivatedByTenant: false,
            scimManaged: false,
          },
        });
        // A re-admitted member starts without keys: whatever they held before
        // is distributed again under the current version.
        await tx.teamMemberKey.deleteMany({
          where: { teamId: invitation.teamId, userId: session.user.id },
        });
        return ACCEPT_OUTCOME.ACCEPTED;
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (e instanceof ScimApprovalPendingRaceError) return errorResponse(API_ERROR.SCIM_APPROVAL_PENDING);
    if (e instanceof ScimManagedMemberRaceError) return errorResponse(API_ERROR.SCIM_MANAGED_MEMBER);
    if (isMembershipLockConflict(e)) return membershipConflictResponse(e);
    throw e;
  }

  if (outcome === ACCEPT_OUTCOME.ALREADY_USED) {
    return errorResponse(API_ERROR.INVITATION_ALREADY_USED);
  }
  if (outcome === ACCEPT_OUTCOME.DEPARTED) {
    return errorResponse(API_ERROR.INVITATION_EXPIRED);
  }
  if (outcome === ACCEPT_OUTCOME.ALREADY_MEMBER) {
    return NextResponse.json({ team: invitation.team, alreadyMember: true });
  }

  return NextResponse.json({
    team: invitation.team,
    role: invitation.role,
    alreadyMember: false,
    needsKeyDistribution: true,
    vaultSetupRequired,
  });
}

export const POST = withRequestLog(handlePOST);
