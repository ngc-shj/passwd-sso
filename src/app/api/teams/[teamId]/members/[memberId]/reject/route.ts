import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";
import { extractRequestMeta } from "@/lib/audit/audit";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { rejectScimPending } from "@/lib/team/scim-admission";
import { isMembershipLockConflict } from "@/lib/team/tenant-row-lock";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_HOUR } from "@/lib/constants/time";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { SCIM_REJECT_OUTCOME, type ScimRejectOutcome } from "@/lib/constants/team/scim-admission";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { membershipConflictResponse } from "@/lib/http/lock-conflict-response";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

const rejectLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 30,
  failClosedOnRedisError: true,
});

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
  let outcome: ScimRejectOutcome | null;
  try {
    outcome = await withTeamTenantRls(
      teamId,
      async (tenantId, tx) => {
        const outcomes = await rejectScimPending(
          tx,
          tenantId,
          { teamId, actorUserId: session.user.id, ip, userAgent },
          [{ memberId, userId: target.userId }],
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

  // null: the module refused the actor (left or demoted).
  if (outcome === null) return errorResponse(API_ERROR.FORBIDDEN);
  if (outcome === SCIM_REJECT_OUTCOME.NOT_FOUND) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
