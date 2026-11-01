import { NextRequest, NextResponse } from "next/server";
import type { TeamInvitation } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { inviteSchema } from "@/lib/validations";
import { hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { INVITATION_STATUS, TEAM_PERMISSION, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { TEAM_INVITATION_TTL_MS } from "@/lib/constants/team/invitation";
import { displayIdentityOf, fetchUserDisplayMap } from "@/lib/audit/audit-user-lookup";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { createLockBudget } from "@/lib/team/team-key-rotation-lock";
import { departedSince, isMembershipLockConflict, lockTenantRows } from "@/lib/team/tenant-row-lock";

const ISSUE_OUTCOME = { ISSUED: "issued", ALREADY_SENT: "already_sent", INVITER_GONE: "inviter_gone" } as const;

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
      // The inviter is hydrated below, outside the team's tenant context: a guest
      // from another primary tenant, or a member who has since left, has a users
      // row RLS hides there, and the REQUIRED relation comes back null — measured:
      // Prisma does not throw.
      orderBy: { createdAt: "desc" },
    }),
  );
  const inviters = await fetchUserDisplayMap(
    invitations.map((inv) => inv.invitedById),
    BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP,
  );

  return NextResponse.json(
    invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      status: inv.status,
      expiresAt: inv.expiresAt,
      invitedBy: displayIdentityOf(inviters, inv.invitedById),
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

  const teamContextPromise = withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { tenantId: true },
    }),
  );

  // Existing-user lookup must bypass team tenant RLS so guest users from a
  // different home tenant are still recognized as already-added team members.
  // Case-insensitive, as accept compares the address: `users.email` is unique
  // only as typed, so every case variant is a candidate invitee. Only id is
  // needed downstream — fetching the full row would expose
  // private-key-encryption material across tenants if the row leaks via logs.
  const existingUsersPromise = withBypassRls(prisma, (tx) =>
    tx.user.findMany({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } }),
  BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP);

  const [team, existingUsers] = await Promise.all([teamContextPromise, existingUsersPromise]);

  if (!team) {
    return notFound();
  }

  const inviteeIds = existingUsers.map((user) => user.id);
  if (inviteeIds.length > 0) {
    const existingMembers = await withTeamTenantRls(teamId, async () =>
      prisma.teamMember.findMany({
        where: { teamId: teamId, userId: { in: inviteeIds } },
        select: { deactivatedAt: true, scimManaged: true, deactivatedByTenant: true },
      }),
    );
    if (existingMembers.some((member) => member.deactivatedAt === null)) {
      return errorResponse(API_ERROR.ALREADY_A_MEMBER);
    }
    // A membership the IdP's group removal ended stays the IdP's; one ended
    // by the user's departure from the tenant is re-invitable.
    if (existingMembers.some((member) => member.scimManaged && !member.deactivatedByTenant)) {
      return errorResponse(API_ERROR.SCIM_MANAGED_MEMBER);
    }
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TEAM_INVITATION_TTL_MS);

  // Issued under the inviter's and the invitees' tenant rows (FOR SHARE,
  // tenant-row-lock.ts): a departure of the inviter waits for this commit and
  // then expires the invitation, and a departure of an invitee orders before
  // or after `created_at`, which the database stamps at insert. A PENDING
  // invitation issued before the invitee left no longer admits (accept
  // refuses it), so it is expired here rather than blocking a new one.
  let issued: { outcome: typeof ISSUE_OUTCOME.ALREADY_SENT } | { outcome: typeof ISSUE_OUTCOME.INVITER_GONE } | {
    outcome: typeof ISSUE_OUTCOME.ISSUED;
    invitation: TeamInvitation;
  };
  try {
    issued = await withTeamTenantRls(
      teamId,
      async (_tenantId, tx) => {
        const rows = await lockTenantRows(tx, team.tenantId, [session.user.id, ...inviteeIds], "share", createLockBudget());
        // The inviter's authority, re-read under their tenant row: a departure
        // that committed after requireTeamPermission ended their membership
        // and expired their invitations, and an invitation stamped after it
        // would read as issued after the departure.
        const inviter = await tx.teamMember.findFirst({
          where: { teamId: teamId, userId: session.user.id, deactivatedAt: null },
          select: { role: true },
        });
        if (!inviter || !hasTeamPermission(inviter.role, TEAM_PERMISSION.MEMBER_INVITE)) {
          return { outcome: ISSUE_OUTCOME.INVITER_GONE };
        }
        const pending = await tx.teamInvitation.findMany({
          where: { teamId: teamId, status: INVITATION_STATUS.PENDING, email: { equals: email, mode: "insensitive" } },
          select: { id: true, createdAt: true },
        });
        for (const existing of pending) {
          if (!inviteeIds.some((id) => departedSince(rows.get(id), existing.createdAt))) {
            return { outcome: ISSUE_OUTCOME.ALREADY_SENT };
          }
        }
        if (pending.length > 0) {
          await tx.teamInvitation.updateMany({
            where: { id: { in: pending.map((inv) => inv.id) }, status: INVITATION_STATUS.PENDING },
            data: { status: INVITATION_STATUS.EXPIRED },
          });
        }
        const invitation = await tx.teamInvitation.create({
          data: {
            teamId: teamId,
            tenantId: team.tenantId,
            email,
            role,
            token,
            expiresAt,
            invitedById: session.user.id,
          },
        });
        return { outcome: ISSUE_OUTCOME.ISSUED, invitation };
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (isMembershipLockConflict(e)) return errorResponse(API_ERROR.CONFLICT);
    throw e;
  }

  if (issued.outcome === ISSUE_OUTCOME.INVITER_GONE) {
    return errorResponse(API_ERROR.FORBIDDEN);
  }
  if (issued.outcome === ISSUE_OUTCOME.ALREADY_SENT) {
    return errorResponse(API_ERROR.INVITATION_ALREADY_SENT);
  }
  const { invitation } = issued;

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
