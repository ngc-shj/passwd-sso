import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAuditInTx, teamAuditBase } from "@/lib/audit/audit";
import { activeTeamAdmission, hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { membershipConflictResponse } from "@/lib/http/lock-conflict-response";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { createLockBudget, lockTeamsAgainstRotation } from "@/lib/team/team-key-rotation-lock";
import { actorDepartedSinceAdmission, isMembershipLockConflict, lockTenantRows } from "@/lib/team/tenant-row-lock";

const CANCEL_OUTCOME = { CANCELLED: "cancelled", ACTOR_GONE: "actor_gone", NOT_FOUND: "not_found" } as const;

type Params = { params: Promise<{ teamId: string; invId: string }> };

// DELETE /api/teams/[teamId]/invitations/[invId] — Cancel invitation
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, invId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.MEMBER_INVITE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // Under the actor's tenant row and the team lock, as invitations POST: a
  // departure, removal or demotion of the actor since the permission check
  // refuses the cancel.
  let outcome: (typeof CANCEL_OUTCOME)[keyof typeof CANCEL_OUTCOME];
  try {
    outcome = await withTeamTenantRls(
      teamId,
      async (tenantId, tx) => {
        const budget = createLockBudget();
        const rows = await lockTenantRows(tx, tenantId, [session.user.id], "share", budget);
        await lockTeamsAgainstRotation(tx, [teamId], budget);
        const actor = await activeTeamAdmission(tx, teamId, session.user.id);
        if (
          !actor ||
          !hasTeamPermission(actor.role, TEAM_PERMISSION.MEMBER_INVITE) ||
          actorDepartedSinceAdmission(rows.get(session.user.id), actor.admittedAt)
        ) {
          return CANCEL_OUTCOME.ACTOR_GONE;
        }
        const invitation = await tx.teamInvitation.findFirst({
          where: { id: invId, teamId },
          select: { email: true, role: true },
        });
        if (!invitation) return CANCEL_OUTCOME.NOT_FOUND;
        const removed = await tx.teamInvitation.deleteMany({ where: { id: invId, teamId } });
        if (removed.count !== 1) return CANCEL_OUTCOME.NOT_FOUND;
        await logAuditInTx(tx, tenantId, {
          ...teamAuditBase(req, session.user.id, teamId),
          action: AUDIT_ACTION.TEAM_MEMBER_INVITE_CANCEL,
          targetType: AUDIT_TARGET_TYPE.TEAM_INVITATION,
          targetId: invId,
          metadata: { email: invitation.email, role: invitation.role },
        });
        return CANCEL_OUTCOME.CANCELLED;
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (isMembershipLockConflict(e)) return membershipConflictResponse(e);
    throw e;
  }

  if (outcome === CANCEL_OUTCOME.ACTOR_GONE) return errorResponse(API_ERROR.FORBIDDEN);
  if (outcome === CANCEL_OUTCOME.NOT_FOUND) return errorResponse(API_ERROR.INVITATION_NOT_FOUND);

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
