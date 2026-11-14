import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { approveMemberSchema } from "@/lib/validations";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TEAM_PERMISSION } from "@/lib/constants";
import { extractRequestMeta } from "@/lib/audit/audit";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { approveScimPending } from "@/lib/team/scim-admission";
import { isMembershipLockConflict } from "@/lib/team/tenant-row-lock";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_HOUR } from "@/lib/constants/time";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { SCIM_APPROVE_OUTCOME, type ScimApproveOutcome } from "@/lib/constants/team/scim-admission";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { membershipConflictResponse } from "@/lib/http/lock-conflict-response";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

const approveLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 30,
  failClosedOnRedisError: true,
});

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
  let outcome: ScimApproveOutcome | null;
  try {
    outcome = await withTeamTenantRls(
      teamId,
      async (tenantId, tx) => {
        const outcomes = await approveScimPending(
          tx,
          tenantId,
          { teamId, actorUserId: session.user.id, ip, userAgent },
          [{ memberId, userId: target.userId, expectedRole }],
        );
        return outcomes?.get(memberId) ?? null;
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    // A rotation, or another admission transaction, held a lock past budget.
    if (isMembershipLockConflict(e)) return membershipConflictResponse(e);
    throw e;
  }

  // null: the module refused the approver (left, demoted, or without the key).
  if (outcome === null) return errorResponse(API_ERROR.FORBIDDEN);
  if (outcome === SCIM_APPROVE_OUTCOME.NOT_FOUND) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  if (outcome === SCIM_APPROVE_OUTCOME.ROLE_CHANGED) return errorResponse(API_ERROR.SCIM_APPROVAL_ROLE_CHANGED);
  // The target left the tenant (plan C3; A6 pins this outcome to 409) — a
  // distinct code from the generic CONFLICT below, so the UI can tell "reject
  // instead" apart from "retry" (review round 2, S-R2-2/F-N1/F-N2/T-N2).
  if (outcome === SCIM_APPROVE_OUTCOME.TENANT_INACTIVE) return errorResponse(API_ERROR.SCIM_APPROVAL_TARGET_INACTIVE);
  // CONFLICT (409): the CAS itself finding 0 rows — unreachable in practice
  // once the checks above pass under the same lock, kept only as the
  // defensive 409 the plan's CAS literally asks for.
  if (outcome === SCIM_APPROVE_OUTCOME.CAS_FAILED) return errorResponse(API_ERROR.CONFLICT);

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
