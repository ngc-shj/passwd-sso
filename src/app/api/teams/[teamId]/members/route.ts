import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { addMemberSchema } from "@/lib/validations";
import { activeTeamRole, hasTeamPermission, requireTeamMember, requireTeamPermission, TeamAuthError } from "@/lib/auth/access/team-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TEAM_PERMISSION, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized, validationError } from "@/lib/http/api-response";
import { buildTeamMemberDisplayItems } from "@/lib/team/team-member-display";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { createLockBudget, lockTeamsAgainstRotation } from "@/lib/team/team-key-rotation-lock";
import { isMembershipLockConflict, lockTenantRows } from "@/lib/team/tenant-row-lock";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/members — List members
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  let membership;
  try {
    membership = await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // Members whose membership ended with their departure from the tenant are
  // listed, flagged `departed`, to those who can remove them — the only
  // action a team takes on them (a return restores them otherwise). A SCIM
  // admission waiting on approval is listed, flagged `pendingApproval`, only
  // to those who can act on it (scim-team-admission-approval, C5) — anyone
  // else sees no pending rows at all.
  const canRemove = hasTeamPermission(membership.role, TEAM_PERMISSION.MEMBER_REMOVE);
  const canInvite = hasTeamPermission(membership.role, TEAM_PERMISSION.MEMBER_INVITE);
  const or: Prisma.TeamMemberWhereInput[] = [{ deactivatedAt: null }];
  if (canRemove) or.push({ deactivatedByTenant: true });
  if (canInvite) or.push({ scimApprovalPending: true });
  const members = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findMany({
      where: or.length > 1 ? { teamId: teamId, OR: or } : { teamId: teamId, deactivatedAt: null },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        deactivatedByTenant: true,
        scimApprovalPending: true,
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    }),
  );

  return NextResponse.json(
    await buildTeamMemberDisplayItems(
      members.map(({ deactivatedByTenant, scimApprovalPending, ...member }) => ({
        ...member,
        departed: deactivatedByTenant,
        pendingApproval: scimApprovalPending,
      })),
    ),
  );
}

// POST /api/teams/[teamId]/members — Direct-add a tenant member
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

  // @stepup id:team-members-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const result = await parseBody(req, addMemberSchema);
  if (!result.ok) return result.response;

  // Lowercase, as the database returns uuids: the self check below compares
  // with the session's id, and an uppercase spelling would slip past it.
  const userId = result.data.userId.toLowerCase();
  const { role } = result.data;

  // Cannot add yourself
  if (userId === session.user.id) {
    return validationError();
  }

  type MemberResult = {
    id: string;
    userId: string;
    role: string;
    reactivated: boolean;
  };

  let member: MemberResult;

  try {
    member = await withTeamTenantRls(
      teamId,
      async (tenantId, tx) => {
        // Admission under the lock order of tenant-row-lock.ts: the target's
        // tenant row (FOR SHARE) decides "active member of the tenant", and a
        // departure of the target either commits first (and is read here) or
        // waits for this commit and then ends the membership created here.
        const budget = createLockBudget();
        // The acting member's row too: their departure, holding it FOR UPDATE,
        // then commits before the re-check below reads their membership.
        const rows = await lockTenantRows(tx, tenantId, [userId, session.user.id], "share", budget);
        const target = rows.get(userId);
        if (!target?.hasRow || target.deactivatedAt !== null) {
          throw new TeamAuthError(API_ERROR.NOT_FOUND, 404);
        }
        await lockTeamsAgainstRotation(tx, [teamId], budget);
        // The acting member's authority as it stands now: a departure,
        // removal or demotion committed since the permission check.
        const actorRole = await activeTeamRole(tx, teamId, session.user.id);
        if (!actorRole || !hasTeamPermission(actorRole, TEAM_PERMISSION.MEMBER_INVITE)) {
          throw new TeamAuthError(API_ERROR.FORBIDDEN, 403);
        }

        // Check existing TeamMember record
        const existing = await tx.teamMember.findFirst({
          where: { teamId, userId },
        });

        if (existing) {
          if (existing.deactivatedAt === null) {
            throw new AlreadyMemberError();
          }
          // Waiting on a team OWNER/ADMIN's approval (scim-team-admission-approval,
          // C6) — distinct from the SCIM_MANAGED_MEMBER refusal below, which a
          // pending row would otherwise also trip (it is always scimManaged too).
          if (existing.scimApprovalPending) {
            throw new ScimApprovalPendingError();
          }
          // A membership the IdP's group removal ended stays the IdP's; one
          // ended by the user's departure from the tenant can be re-added.
          if (existing.scimManaged && !existing.deactivatedByTenant) {
            throw new ScimManagedError();
          }

          // Reactivate: delete stale keys + update member
          await tx.teamMemberKey.deleteMany({ where: { teamId, userId } });
          const updated = await tx.teamMember.update({
            where: { id: existing.id },
            data: {
              deactivatedAt: null,
              deactivatedByTenant: false,
              role,
              keyDistributed: false,
              scimManaged: false,
            },
          });
          return { id: updated.id, userId: updated.userId, role: updated.role, reactivated: true };
        }

        // Create new TeamMember
        const created = await tx.teamMember.create({
          data: {
            teamId,
            userId,
            tenantId,
            role,
            keyDistributed: false,
          },
        });
        return { id: created.id, userId: created.userId, role: created.role, reactivated: false };
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (e instanceof AlreadyMemberError) {
      return errorResponse(API_ERROR.ALREADY_A_MEMBER);
    }
    if (e instanceof ScimManagedError) {
      return errorResponse(API_ERROR.SCIM_MANAGED_MEMBER);
    }
    if (e instanceof ScimApprovalPendingError) {
      return errorResponse(API_ERROR.SCIM_APPROVAL_PENDING);
    }
    if (isMembershipLockConflict(e)) {
      return errorResponse(API_ERROR.CONFLICT);
    }
    // Prisma unique constraint violation (race condition)
    if (isPrismaUniqueConstraintError(e)) {
      return errorResponse(API_ERROR.ALREADY_A_MEMBER);
    }
    return handleAuthError(e);
  }

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.TEAM_MEMBER_ADD,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: member.id,
    metadata: { userId, role, reactivated: member.reactivated },
  });

  return NextResponse.json(member, { status: 201 });
}

class AlreadyMemberError extends Error {
  constructor() { super("ALREADY_A_MEMBER"); }
}

class ScimManagedError extends Error {
  constructor() { super("SCIM_MANAGED_MEMBER"); }
}

class ScimApprovalPendingError extends Error {
  constructor() { super("SCIM_APPROVAL_PENDING"); }
}

function isPrismaUniqueConstraintError(e: unknown): boolean {
  if (
    typeof e !== "object" ||
    e === null ||
    !("code" in e) ||
    (e as { code: string }).code !== "P2002"
  ) {
    return false;
  }
  // Verify it's the teamId+userId constraint, not an unrelated one
  const meta = "meta" in e ? (e as { meta?: { target?: unknown } }).meta : undefined;
  if (Array.isArray(meta?.target)) {
    return meta.target.includes("teamId") && meta.target.includes("userId");
  }
  return false; // Unknown constraint or non-array target — let the caller re-throw
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
