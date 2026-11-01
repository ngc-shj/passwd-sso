import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { updateMemberRoleSchema } from "@/lib/validations";
import {
  requireTeamPermission,
  isRoleAbove,
} from "@/lib/auth/access/team-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TEAM_PERMISSION, TEAM_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { isTeamRotationConflict, lockTeamsAgainstRotation } from "@/lib/team/team-key-rotation-lock";
import {
  invalidateUserSessions,
  type InvalidateUserSessionsResult,
} from "@/lib/auth/session/user-session-invalidation";
import { getLogger } from "@/lib/logger";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { buildTeamMemberDisplayItems } from "@/lib/team/team-member-display";
import { errorLogFields } from "@/lib/logger/error-fields";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

/**
 * A row the change needed active (the target, or the acting member) was not,
 * when re-read under the team lock: a departure from the tenant, or a removal,
 * committed since the checks above.
 */
class MemberChangedError extends Error {
  constructor() {
    super("MEMBER_CHANGED");
  }
}

async function buildMemberRoleResponse(member: {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
}) {
  const [display] = await buildTeamMemberDisplayItems([member]);

  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    name: display?.name ?? null,
    email: display?.email ?? null,
    image: display?.image ?? null,
    tenantName: display?.tenantName ?? null,
  };
}

// PUT /api/teams/[teamId]/members/[memberId] — Change member role
async function handlePUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, memberId } = await params;

  let actorMembership;
  try {
    actorMembership = await requireTeamPermission(
        session.user.id,
        teamId,
        TEAM_PERMISSION.MEMBER_CHANGE_ROLE,
        req
      );
  } catch (e) {
    return handleAuthError(e);
  }

  // @stepup id:team-member-put method:PUT
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const target = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findUnique({
      where: { id: memberId },
    }),
  );

  if (!target || target.teamId !== teamId || target.deactivatedAt !== null) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  }

  const result = await parseBody(req, updateMemberRoleSchema);
  if (!result.ok) return result.response;

  // Owner transfer: only OWNER can promote someone to OWNER
  if (result.data.role === TEAM_ROLE.OWNER) {
    if (actorMembership.role !== TEAM_ROLE.OWNER) {
      return errorResponse(API_ERROR.OWNER_ONLY);
    }

    // Transfer: promote target to OWNER, demote self to ADMIN (atomic). Both
    // rows must still be active under the team lock: transferring to a member
    // who just left the tenant would leave the team without an active OWNER.
    let updated;
    try {
      updated = await withTeamTenantRls(teamId, async (_tenantId, tx) => {
        await lockTeamsAgainstRotation(tx, [teamId]);
        const demoted = await tx.teamMember.updateMany({
          where: { id: actorMembership.id, teamId, role: TEAM_ROLE.OWNER, deactivatedAt: null },
          data: { role: TEAM_ROLE.ADMIN },
        });
        const promoted = await tx.teamMember.updateMany({
          where: { id: memberId, teamId, deactivatedAt: null },
          data: { role: TEAM_ROLE.OWNER },
        });
        if (demoted.count !== 1 || promoted.count !== 1) throw new MemberChangedError();
        return tx.teamMember.findUniqueOrThrow({ where: { id: memberId }, select: { id: true, userId: true, role: true, createdAt: true } });
      });
    } catch (e) {
      if (e instanceof MemberChangedError) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
      if (isTeamRotationConflict(e)) return errorResponse(API_ERROR.CONFLICT);
      throw e;
    }

    await logAuditAsync({
      ...teamAuditBase(req, session.user.id, teamId),
      action: AUDIT_ACTION.TEAM_ROLE_UPDATE,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: memberId,
      metadata: { newRole: TEAM_ROLE.OWNER, previousRole: target.role, transfer: true },
    });

    return NextResponse.json(await buildMemberRoleResponse(updated));
  }

  // Cannot change OWNER role (unless transferring ownership above)
  if (target.role === TEAM_ROLE.OWNER) {
    return errorResponse(API_ERROR.CANNOT_CHANGE_OWNER_ROLE);
  }

  // Cannot change role of someone at or above your level (except OWNER can do anything)
  if (
    actorMembership.role !== TEAM_ROLE.OWNER &&
    !isRoleAbove(actorMembership.role, target.role)
  ) {
    return errorResponse(API_ERROR.CANNOT_CHANGE_HIGHER_ROLE);
  }

  // The acting member and the target must both still be active under the
  // team lock: a departure from the tenant committed since the checks above
  // ends either membership.
  let updated;
  try {
    updated = await withTeamTenantRls(teamId, async (_tenantId, tx) => {
      await lockTeamsAgainstRotation(tx, [teamId]);
      const actorActive = await tx.teamMember.count({
        where: { id: actorMembership.id, teamId, deactivatedAt: null },
      });
      const changed = await tx.teamMember.updateMany({
        where: { id: memberId, teamId, deactivatedAt: null, role: target.role },
        data: { role: result.data.role },
      });
      if (actorActive !== 1 || changed.count !== 1) throw new MemberChangedError();
      return tx.teamMember.findUniqueOrThrow({ where: { id: memberId }, select: { id: true, userId: true, role: true, createdAt: true } });
    });
  } catch (e) {
    if (e instanceof MemberChangedError) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
    if (isTeamRotationConflict(e)) return errorResponse(API_ERROR.CONFLICT);
    throw e;
  }

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.TEAM_ROLE_UPDATE,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: memberId,
    metadata: { newRole: result.data.role, previousRole: target.role },
  });

  return NextResponse.json(await buildMemberRoleResponse(updated));
}

// DELETE /api/teams/[teamId]/members/[memberId] — Remove member
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, memberId } = await params;

  let actorMembership;
  try {
    actorMembership = await requireTeamPermission(
        session.user.id,
        teamId,
        TEAM_PERMISSION.MEMBER_REMOVE,
        req
      );
  } catch (e) {
    return handleAuthError(e);
  }

  // @stepup id:team-member-delete method:DELETE
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const target = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findUnique({
      where: { id: memberId },
      select: { teamId: true, deactivatedAt: true, deactivatedByTenant: true, role: true, userId: true, tenantId: true },
    }),
  );

  // An active member, or one whose membership ended with their departure from
  // the tenant: removing that one keeps a later return from restoring it.
  const removable = target && (target.deactivatedAt === null || target.deactivatedByTenant);
  if (!target || target.teamId !== teamId || !removable) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  }

  if (target.role === TEAM_ROLE.OWNER) {
    return errorResponse(API_ERROR.CANNOT_REMOVE_OWNER);
  }

  if (
    actorMembership.role !== TEAM_ROLE.OWNER &&
    !isRoleAbove(actorMembership.role, target.role)
  ) {
    return errorResponse(API_ERROR.CANNOT_REMOVE_HIGHER_ROLE);
  }

  try {
    await withTeamTenantRls(teamId, async (_tenantId, tx) => {
      // Serialise with key rotation first: a removal committing after a
      // rotation read the member set would leave the removed member a key to
      // the new version (team-key-rotation-lock.ts).
      await lockTeamsAgainstRotation(tx, [teamId]);
      // The acting member must still be active: a departure from the tenant
      // committed since the permission check ended their membership.
      const actorActive = await tx.teamMember.count({
        where: { id: actorMembership.id, teamId, deactivatedAt: null },
      });
      if (actorActive !== 1) throw new MemberChangedError();
      // Re-read under the lock: the row is still active or departed (a return
      // or a group removal since the check above changes what is removed).
      const removed = await tx.teamMember.deleteMany({
        where: { id: memberId, teamId, OR: [{ deactivatedAt: null }, { deactivatedByTenant: true }] },
      });
      if (removed.count !== 1) throw new MemberChangedError();
      await tx.teamMemberKey.deleteMany({ where: { teamId: teamId, userId: target.userId } });
    });
  } catch (e) {
    if (e instanceof MemberChangedError) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
    // A rotation of this team held it past the lock wait; nothing was removed.
    if (isTeamRotationConflict(e)) return errorResponse(API_ERROR.CONFLICT);
    throw e;
  }

  // Session/token invalidation — outside transaction (fail-open)
  let invalidationCounts: InvalidateUserSessionsResult | undefined;
  let sessionInvalidationFailed = false;
  try {
    invalidationCounts = await invalidateUserSessions(target.userId, {
      tenantId: target.tenantId,
    });
  } catch (error) {
    sessionInvalidationFailed = true;
    getLogger().error({ userId: target.userId, error: errorLogFields(error) }, "session-invalidation-failed");
  }

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.TEAM_MEMBER_REMOVE,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: memberId,
    metadata: {
      removedUserId: target.userId,
      removedRole: target.role,
      ...(invalidationCounts ?? {}),
      ...(sessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
  });

  return NextResponse.json({ success: true });
}

export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
