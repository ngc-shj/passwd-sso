import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, TEAM_PERMISSION } from "@/lib/constants";
import { extractRequestMeta, logAuditInTx } from "@/lib/audit/audit";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { createLockBudget, lockTeamsAgainstRotation } from "@/lib/team/team-key-rotation-lock";
import { isMembershipLockConflict, lockTenantRows } from "@/lib/team/tenant-row-lock";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_HOUR } from "@/lib/constants/time";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

const rejectLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 30,
  failClosedOnRedisError: true,
});

const REJECT_OUTCOME = {
  REJECTED: "rejected",
  ACTOR_NOT_PERMITTED: "actor_not_permitted",
  NOT_FOUND: "not_found",
} as const;

// POST /api/teams/[teamId]/members/[memberId]/reject — A team OWNER/ADMIN
// clears a SCIM-pending membership (scim-team-admission-approval, C3). Unlike
// approve, this hands nothing over: a team with no key-holding OWNER/ADMIN
// can still reject (SC5).
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, memberId } = await params;

  try {
    // A pending or non-member caller (including the pending member on their
    // own row) gets 404 here — requireTeamMember only sees active rows.
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // @stepup id:team-member-reject-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rejectLimiter,
    key: `rl:team_member_reject:${session.user.id}`,
    scope: "teams.member_reject",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  if (!z.string().uuid().safeParse(memberId).success) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  }

  // Unlocked pre-read, just for the row's userId — the lock below needs it
  // to serialise with the target's tenant membership.
  const target = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findUnique({
      where: { id: memberId },
      select: { teamId: true, userId: true },
    }),
  );
  if (!target || target.teamId !== teamId) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  }

  const { ip, userAgent } = extractRequestMeta(req);
  let outcome: (typeof REJECT_OUTCOME)[keyof typeof REJECT_OUTCOME];
  try {
    outcome = await withTeamTenantRls(
      teamId,
      async (tenantId, tx) => {
        // Lock order (tenant-row-lock.ts): both tenant rows (FOR SHARE) in
        // one call, then the team — the only lock reject shares with SCIM
        // (lockGroupWrite) is the target's tenant-row advisory lock.
        const budget = createLockBudget();
        await lockTenantRows(tx, tenantId, [session.user.id, target.userId], "share", budget);
        await lockTeamsAgainstRotation(tx, [teamId], budget);

        // The actor's authority as it stands now: active, and holding
        // MEMBER_INVITE (OWNER/ADMIN only) — a departure, removal or demotion
        // since the permission check above ends it. No key requirement: a
        // team without a key holder can still clear requests (SC5).
        const actor = await tx.teamMember.findFirst({
          where: { teamId, userId: session.user.id, deactivatedAt: null },
          select: { role: true },
        });
        if (!actor || !hasTeamPermission(actor.role, TEAM_PERMISSION.MEMBER_INVITE)) {
          return REJECT_OUTCOME.ACTOR_NOT_PERMITTED;
        }

        // Locked re-read of the target: still pending, for the audit row's
        // role. (Self-rejection is ruled out structurally: the actor's row
        // above is active, and a pending row is always deactivated.)
        const lockedTarget = await tx.teamMember.findFirst({
          where: { id: memberId, teamId, userId: target.userId, scimApprovalPending: true },
          select: { role: true },
        });
        if (!lockedTarget) return REJECT_OUTCOME.NOT_FOUND;

        const removed = await tx.teamMember.deleteMany({
          where: { id: memberId, teamId, scimApprovalPending: true },
        });
        if (removed.count !== 1) return REJECT_OUTCOME.NOT_FOUND;

        await logAuditInTx(tx, tenantId, {
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.TEAM_MEMBER_SCIM_REJECT,
          userId: session.user.id,
          tenantId,
          teamId,
          targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
          targetId: target.userId,
          metadata: { memberId, role: lockedTarget.role },
          ip,
          userAgent,
        });

        return REJECT_OUTCOME.REJECTED;
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    // A rotation, or another admission transaction, held a lock past budget.
    if (isMembershipLockConflict(e)) return errorResponse(API_ERROR.CONFLICT);
    throw e;
  }

  if (outcome === REJECT_OUTCOME.ACTOR_NOT_PERMITTED) return errorResponse(API_ERROR.FORBIDDEN);
  if (outcome === REJECT_OUTCOME.NOT_FOUND) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
