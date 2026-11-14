import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { bulkApproveMembersSchema } from "@/lib/validations";
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

type Params = { params: Promise<{ teamId: string }> };

const bulkApproveLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 10,
  failClosedOnRedisError: true,
});

// POST /api/teams/[teamId]/members/bulk-approve — A key-holding team
// OWNER/ADMIN admits up to SCIM_BULK_ADMISSION_MAX SCIM-pending memberships in
// one request (scim-bulk-approve, C2). Body: { members: [{ memberId,
// expectedRole }] }. Every row goes through the same adjudicator as the single
// approve route; a refused row is reported and the others commit.
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

  // @stepup id:team-member-bulk-approve-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: bulkApproveLimiter,
    key: `rl:team_member_bulk_approve:${session.user.id}`,
    scope: "teams.member_bulk_approve",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  const result = await parseBody(req, bulkApproveMembersSchema);
  if (!result.ok) return result.response;
  const { members } = result.data;

  // Unlocked pre-read: only rows pending now enter the transaction, so a list
  // of active members' ids takes no lock, and it supplies each row's userId
  // for the tenant-row locks.
  const pending = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findMany({
      where: { id: { in: members.map((m) => m.memberId) }, teamId, scimApprovalPending: true },
      select: { id: true, userId: true },
    }),
  );

  const outcomes = new Map<string, ScimApproveOutcome>();
  if (pending.length > 0) {
    // Looked up by memberId, never by position: the pre-read's order is the
    // database's, not the request's.
    const expectedRoles = new Map(members.map((m) => [m.memberId, m.expectedRole]));
    const targets = pending.flatMap((row) => {
      const expectedRole = expectedRoles.get(row.id);
      return expectedRole === undefined ? [] : [{ memberId: row.id, userId: row.userId, expectedRole }];
    });

    const { ip, userAgent } = extractRequestMeta(req);
    let admitted: Map<string, ScimApproveOutcome> | null;
    try {
      admitted = await withTeamTenantRls(
        teamId,
        (tenantId, tx) =>
          approveScimPending(
            tx,
            tenantId,
            { teamId, actorUserId: session.user.id, ip, userAgent, batchId: randomUUID() },
            targets,
          ),
        { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
      );
    } catch (e) {
      // A rotation, SCIM write, or another admission held a lock past budget;
      // the transaction rolled back, so nothing committed.
      if (isMembershipLockConflict(e)) return membershipConflictResponse(e);
      throw e;
    }

    // null: the module refused the approver (left, demoted, or without the key).
    if (admitted === null) return errorResponse(API_ERROR.FORBIDDEN);
    for (const [memberId, outcome] of admitted) outcomes.set(memberId, outcome);
  }

  return NextResponse.json({
    results: members.map(({ memberId }) => ({
      memberId,
      outcome: outcomes.get(memberId) ?? SCIM_APPROVE_OUTCOME.NOT_FOUND,
    })),
  });
}

export const POST = withRequestLog(handlePOST);
