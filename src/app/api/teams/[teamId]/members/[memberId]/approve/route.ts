import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { approveMemberSchema } from "@/lib/validations";
import { hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
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
import { membershipConflictResponse } from "@/lib/http/lock-conflict-response";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

const approveLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 30,
  failClosedOnRedisError: true,
});

const APPROVE_OUTCOME = {
  APPROVED: "approved",
  ACTOR_NOT_PERMITTED: "actor_not_permitted",
  NOT_FOUND: "not_found",
  ROLE_CHANGED: "role_changed",
  TENANT_INACTIVE: "tenant_inactive",
  CAS_FAILED: "cas_failed",
} as const;

// POST /api/teams/[teamId]/members/[memberId]/approve — A key-holding team
// OWNER/ADMIN admits a SCIM-pending membership (scim-team-admission-approval,
// C3). Body: { expectedRole } — the role shown to the approver, so a raise
// since (another SCIM group add) is caught rather than silently admitted.
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

  // @stepup id:team-member-approve-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: approveLimiter,
    key: `rl:team_member_approve:${session.user.id}`,
    scope: "teams.member_approve",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  if (!z.string().uuid().safeParse(memberId).success) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  }

  const result = await parseBody(req, approveMemberSchema);
  if (!result.ok) return result.response;
  const { expectedRole } = result.data;

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
  let outcome: (typeof APPROVE_OUTCOME)[keyof typeof APPROVE_OUTCOME];
  try {
    outcome = await withTeamTenantRls(
      teamId,
      async (tenantId, tx) => {
        // Lock order (tenant-row-lock.ts): both tenant rows (FOR SHARE) in
        // one call, then the team — the only lock approve shares with SCIM
        // (lockGroupWrite) is the target's tenant-row advisory lock.
        const budget = createLockBudget();
        const rows = await lockTenantRows(tx, tenantId, [session.user.id, target.userId], "share", budget);
        await lockTeamsAgainstRotation(tx, [teamId], budget);

        // The approver's authority as it stands now: active, and holding
        // MEMBER_INVITE (OWNER/ADMIN only) — a departure, removal or demotion
        // since the permission check above ends it. Approve additionally
        // needs the current team key: rotation wraps only active distributed
        // members, so this is "holds the current key version".
        const approver = await tx.teamMember.findFirst({
          where: { teamId, userId: session.user.id, deactivatedAt: null },
          select: { role: true, keyDistributed: true },
        });
        if (!approver || !hasTeamPermission(approver.role, TEAM_PERMISSION.MEMBER_INVITE) || !approver.keyDistributed) {
          return APPROVE_OUTCOME.ACTOR_NOT_PERMITTED;
        }

        // Locked re-read of the target: still pending. Checked before any
        // 409 below, so a row no longer pending (a concurrent approve/reject,
        // or a SCIM withdraw) answers 404 rather than a role/tenant conflict.
        // (Self-approval is ruled out structurally: the approver's row above
        // is active, and a pending row is always deactivated — no user can
        // satisfy both reads.)
        const lockedTarget = await tx.teamMember.findFirst({
          where: { id: memberId, teamId, userId: target.userId, scimApprovalPending: true },
          select: { role: true },
        });
        if (!lockedTarget) return APPROVE_OUTCOME.NOT_FOUND;

        if (lockedTarget.role !== expectedRole) return APPROVE_OUTCOME.ROLE_CHANGED;

        const targetTenantRow = rows.get(target.userId);
        if (!targetTenantRow?.hasRow || targetTenantRow.deactivatedAt !== null) {
          return APPROVE_OUTCOME.TENANT_INACTIVE;
        }

        const admitted = await tx.teamMember.updateMany({
          where: {
            id: memberId,
            teamId,
            role: expectedRole,
            scimApprovalPending: true,
            deactivatedAt: { not: null },
          },
          data: { deactivatedAt: null, scimApprovalPending: false, keyDistributed: false },
        });
        if (admitted.count !== 1) return APPROVE_OUTCOME.CAS_FAILED;

        await logAuditInTx(tx, tenantId, {
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.TEAM_MEMBER_SCIM_APPROVE,
          userId: session.user.id,
          tenantId,
          teamId,
          targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
          targetId: target.userId,
          metadata: { memberId, role: expectedRole },
          ip,
          userAgent,
        });

        return APPROVE_OUTCOME.APPROVED;
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    // A rotation, or another admission transaction, held a lock past budget.
    if (isMembershipLockConflict(e)) return membershipConflictResponse(e);
    throw e;
  }

  if (outcome === APPROVE_OUTCOME.ACTOR_NOT_PERMITTED) return errorResponse(API_ERROR.FORBIDDEN);
  if (outcome === APPROVE_OUTCOME.NOT_FOUND) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  if (outcome === APPROVE_OUTCOME.ROLE_CHANGED) return errorResponse(API_ERROR.SCIM_APPROVAL_ROLE_CHANGED);
  // The target left the tenant (plan C3; A6 pins this outcome to 409) — a
  // distinct code from the generic CONFLICT below, so the UI can tell "reject
  // instead" apart from "retry" (review round 2, S-R2-2/F-N1/F-N2/T-N2).
  if (outcome === APPROVE_OUTCOME.TENANT_INACTIVE) return errorResponse(API_ERROR.SCIM_APPROVAL_TARGET_INACTIVE);
  // CONFLICT (409): the CAS itself finding 0 rows — unreachable in practice
  // once the checks above pass under the same lock, kept only as the
  // defensive 409 the plan's CAS literally asks for.
  if (outcome === APPROVE_OUTCOME.CAS_FAILED) return errorResponse(API_ERROR.CONFLICT);

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
