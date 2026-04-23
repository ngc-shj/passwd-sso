import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit";
import { updateMemberRoleSchema } from "@/lib/validations";
import {
  requireTeamPermission,
  isRoleAbove,
} from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION, TEAM_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { invalidateUserSessions } from "@/lib/auth/user-session-invalidation";
import { getLogger } from "@/lib/logger";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

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

  const target = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findUnique({
      where: { id: memberId },
    }),
  );

  if (!target || target.teamId !== teamId || target.deactivatedAt !== null) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND, 404);
  }

  const result = await parseBody(req, updateMemberRoleSchema);
  if (!result.ok) return result.response;

  // Owner transfer: only OWNER can promote someone to OWNER
  if (result.data.role === TEAM_ROLE.OWNER) {
    if (actorMembership.role !== TEAM_ROLE.OWNER) {
      return errorResponse(API_ERROR.OWNER_ONLY, 403);
    }

    // Transfer: promote target to OWNER, demote self to ADMIN (atomic)
    const [, updated] = await withTeamTenantRls(teamId, async () =>
      prisma.$transaction([
        prisma.teamMember.update({
          where: { id: actorMembership.id },
          data: { role: TEAM_ROLE.ADMIN },
        }),
        prisma.teamMember.update({
          where: { id: memberId },
          data: { role: TEAM_ROLE.OWNER },
          include: {
            user: { select: { id: true, name: true, email: true, image: true } },
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

    return NextResponse.json({
      id: updated.id,
      userId: updated.userId,
      role: updated.role,
      name: updated.user.name,
      email: updated.user.email,
      image: updated.user.image,
    });
  }

  // Cannot change OWNER role (unless transferring ownership above)
  if (target.role === TEAM_ROLE.OWNER) {
    return errorResponse(API_ERROR.CANNOT_CHANGE_OWNER_ROLE, 403);
  }

  // Cannot change role of someone at or above your level (except OWNER can do anything)
  if (
    actorMembership.role !== TEAM_ROLE.OWNER &&
    !isRoleAbove(actorMembership.role, target.role)
  ) {
    return errorResponse(API_ERROR.CANNOT_CHANGE_HIGHER_ROLE, 403);
  }

  const updated = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.update({
      where: { id: memberId },
      data: { role: result.data.role },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
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

  return NextResponse.json({
    id: updated.id,
    userId: updated.userId,
    role: updated.role,
    name: updated.user.name,
    email: updated.user.email,
    image: updated.user.image,
  });
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

  const target = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findUnique({
      where: { id: memberId },
      select: { teamId: true, deactivatedAt: true, role: true, userId: true, tenantId: true },
    }),
  );

  if (!target || target.teamId !== teamId || target.deactivatedAt !== null) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND, 404);
  }

  if (target.role === TEAM_ROLE.OWNER) {
    return errorResponse(API_ERROR.CANNOT_REMOVE_OWNER, 403);
  }

  if (
    actorMembership.role !== TEAM_ROLE.OWNER &&
    !isRoleAbove(actorMembership.role, target.role)
  ) {
    return errorResponse(API_ERROR.CANNOT_REMOVE_HIGHER_ROLE, 403);
  }

  await withTeamTenantRls(teamId, async () =>
    prisma.$transaction([
      prisma.teamMemberKey.deleteMany({ where: { teamId: teamId, userId: target.userId } }),
      prisma.teamMember.delete({ where: { id: memberId } }),
    ]),
  );

  // Session/token invalidation — outside transaction (fail-open)
  let invalidationCounts: { sessions: number; extensionTokens: number; apiKeys: number } | undefined;
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
