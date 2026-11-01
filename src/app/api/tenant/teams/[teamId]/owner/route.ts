import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hasTenantPermission, requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, TEAM_ROLE, TENANT_ROLE } from "@/lib/constants";
import { MS_PER_HOUR } from "@/lib/constants/time";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { extractRequestMeta, logAuditInTx } from "@/lib/audit/audit";
import { withTenantRls } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { createLockBudget, withBoundedLockWait } from "@/lib/team/team-key-rotation-lock";
import { isMembershipLockConflict, lockTenantRows } from "@/lib/team/tenant-row-lock";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";

const assignOwnerSchema = z.object({ userId: z.string().uuid() });

const ownerAssignLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 10,
  failClosedOnRedisError: true,
});

const ASSIGN_OUTCOME = {
  ASSIGNED: "assigned",
  NOT_FOUND: "not_found",
  HAS_OWNER: "has_owner",
  NOT_ACTIVE: "not_active",
  ACTOR_NOT_PERMITTED: "actor_not_permitted",
} as const;

type Params = { params: Promise<{ teamId: string }> };

// POST /api/tenant/teams/[teamId]/owner — Assign the OWNER of a team of the
// actor's tenant that has no active one (its owner left the tenant). Tenant
// OWNER/ADMIN only (TEAM_OWNER_ASSIGN), not a team ADMIN: the team itself has
// nobody left who may decide.
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.TEAM_OWNER_ASSIGN);
  } catch (e) {
    return handleAuthError(e);
  }

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: ownerAssignLimiter,
    key: `rl:tenant_team_owner_assign:${session.user.id}`,
    scope: "tenant.team_owner_assign",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  // @stepup id:tenant-team-owner-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const result = await parseBody(req, assignOwnerSchema);
  if (!result.ok) return result.response;
  const { userId: targetUserId } = result.data;

  // A guard against mistakes, not an authorization boundary: a tenant ADMIN
  // can already join any team through a SCIM group mapping. Assigning oneself
  // is left to the tenant OWNER (re-checked below on the role read under lock).
  const selfAssigned = targetUserId.toLowerCase() === session.user.id.toLowerCase();
  if (selfAssigned && actor.role !== TENANT_ROLE.OWNER) {
    return errorResponse(API_ERROR.FORBIDDEN);
  }

  const { ip, userAgent } = extractRequestMeta(req);
  let outcome: (typeof ASSIGN_OUTCOME)[keyof typeof ASSIGN_OUTCOME];
  try {
    outcome = await withTenantRls(
      prisma,
      actor.tenantId,
      async (tx) => {
        // Read under the ACTOR's tenant: another tenant's team is not found.
        const team = await tx.team.findUnique({ where: { id: teamId }, select: { tenantId: true } });
        if (!team || team.tenantId !== actor.tenantId) return ASSIGN_OUTCOME.NOT_FOUND;

        // Lock order (tenant-row-lock.ts): the actor's and the target's tenant
        // rows, then the team — FOR NO KEY UPDATE, which waits for any
        // departure or admission holding it FOR SHARE.
        const budget = createLockBudget();
        const rows = await lockTenantRows(tx, actor.tenantId, [session.user.id, targetUserId], "share", budget);
        const isActive = (id: string) => {
          const row = rows.get(id);
          return row?.hasRow === true && row.deactivatedAt === null;
        };
        // The actor's tenant role as of the lock: a demotion committed since
        // requireTenantPermission applies, here and to the self-assign rule.
        const actorRole = rows.get(session.user.id)?.role ?? null;
        if (
          !actorRole ||
          !hasTenantPermission(actorRole, TENANT_PERMISSION.TEAM_OWNER_ASSIGN) ||
          (selfAssigned && actorRole !== TENANT_ROLE.OWNER)
        ) {
          return ASSIGN_OUTCOME.ACTOR_NOT_PERMITTED;
        }
        if (!isActive(session.user.id) || !isActive(targetUserId)) return ASSIGN_OUTCOME.NOT_ACTIVE;
        await withBoundedLockWait(
          tx,
          () => tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR NO KEY UPDATE`,
          { budget },
        );

        const activeOwners = await tx.teamMember.count({
          where: { teamId, role: TEAM_ROLE.OWNER, deactivatedAt: null },
        });
        if (activeOwners > 0) return ASSIGN_OUTCOME.HAS_OWNER;
        const target = await tx.teamMember.findFirst({
          where: { teamId, userId: targetUserId, deactivatedAt: null },
          select: { id: true },
        });
        if (!target) return ASSIGN_OUTCOME.NOT_ACTIVE;

        // Every other OWNER row is a departed one: demoted, so a later return
        // of that member does not give the team two owners.
        const demoted = await tx.teamMember.findMany({
          where: { teamId, role: TEAM_ROLE.OWNER, id: { not: target.id } },
          select: { userId: true },
        });
        await tx.teamMember.updateMany({
          where: { teamId, role: TEAM_ROLE.OWNER, id: { not: target.id } },
          data: { role: TEAM_ROLE.ADMIN },
        });
        await tx.teamMember.update({ where: { id: target.id }, data: { role: TEAM_ROLE.OWNER } });

        await logAuditInTx(tx, actor.tenantId, {
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.TEAM_OWNER_ASSIGNED_BY_TENANT_ADMIN,
          userId: session.user.id,
          tenantId: actor.tenantId,
          teamId,
          targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
          targetId: target.id,
          metadata: {
            targetUserId,
            demotedUserIds: demoted.map((m) => m.userId),
            selfAssigned,
          },
          ip,
          userAgent,
        });
        return ASSIGN_OUTCOME.ASSIGNED;
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (isMembershipLockConflict(e)) return errorResponse(API_ERROR.CONFLICT);
    throw e;
  }

  if (outcome === ASSIGN_OUTCOME.NOT_FOUND) return notFound();
  if (outcome === ASSIGN_OUTCOME.ACTOR_NOT_PERMITTED) return errorResponse(API_ERROR.FORBIDDEN);
  if (outcome === ASSIGN_OUTCOME.HAS_OWNER) return errorResponse(API_ERROR.CONFLICT);
  if (outcome === ASSIGN_OUTCOME.NOT_ACTIVE) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);

  return NextResponse.json({ teamId, ownerUserId: targetUserId });
}

export const POST = withRequestLog(handlePOST);
