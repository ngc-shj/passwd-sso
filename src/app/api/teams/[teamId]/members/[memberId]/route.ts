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
import {
  invalidateUserSessions,
  type InvalidateUserSessionsResult,
} from "@/lib/auth/session/user-session-invalidation";
import { getLogger } from "@/lib/logger";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { buildTeamMemberDisplayItems } from "@/lib/team/team-member-display";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

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

  const stepUpError = await requireRecentCurrentAuthMethod(req);
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

    // Transfer: promote target to OWNER, demote self to ADMIN (atomic)
    const [, updated] = await withTeamTenantRls(teamId, async () =>
      prisma.$transaction([
        prisma.teamMember.update({
          where: { id: actorMembership.id, teamId },
          data: { role: TEAM_ROLE.ADMIN },
        }),
        prisma.teamMember.update({
          where: { id: memberId, teamId },
          data: { role: TEAM_ROLE.OWNER },
          select: {
            id: true,
            userId: true,
            role: true,
            createdAt: true,
          },
        }),
      ]),
    );

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

  const updated = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.update({
      where: { id: memberId, teamId },
      data: { role: result.data.role },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
      },
    }),
  );

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

  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  const target = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findUnique({
      where: { id: memberId },
      select: { teamId: true, deactivatedAt: true, role: true, userId: true, tenantId: true },
    }),
  );

  if (!target || target.teamId !== teamId || target.deactivatedAt !== null) {
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

  await withTeamTenantRls(teamId, async () =>
    prisma.$transaction([
      prisma.teamMemberKey.deleteMany({ where: { teamId: teamId, userId: target.userId } }),
      prisma.teamMember.delete({ where: { id: memberId, teamId } }),
    ]),
  );

  // Session/token invalidation — outside transaction (fail-open)
  let invalidationCounts: InvalidateUserSessionsResult | undefined;
  let sessionInvalidationFailed = false;
  try {
    invalidationCounts = await invalidateUserSessions(target.userId, {
      tenantId: target.tenantId,
    });
  } catch (error) {
    sessionInvalidationFailed = true;
    getLogger().error({ userId: target.userId, error }, "session-invalidation-failed");
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
