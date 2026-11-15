import type { Prisma, TeamRole } from "@prisma/client";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, TEAM_PERMISSION } from "@/lib/constants";
import {
  SCIM_APPROVE_OUTCOME,
  SCIM_REJECT_OUTCOME,
  type ScimApproveOutcome,
  type ScimRejectOutcome,
} from "@/lib/constants/team/scim-admission";
import { hasTeamPermission } from "@/lib/auth/access/team-auth";
import { logAuditInTx } from "@/lib/audit/audit";
import { createLockBudget, lockTeamsAgainstRotation } from "@/lib/team/team-key-rotation-lock";
import { actorDepartedSinceAdmission, lockTenantRows } from "@/lib/team/tenant-row-lock";

/**
 * The adjudicator for admitting or clearing SCIM-pending team memberships
 * (scim-team-admission-approval; docs/archive/review/scim-bulk-approve-plan.md
 * C1). The single and the bulk routes all decide here, so there is one copy of
 * the decision. Rule 7 of check-team-rotation-input-lock.mjs keeps it that
 * way: only the four routes import this module, and only it clears
 * `scimApprovalPending`.
 *
 * Each function MUST run inside an open transaction under the team's tenant
 * RLS context. It takes the locks itself, then decides every target under
 * them; it writes nothing for a refused target, and a throw from any
 * statement propagates so the caller's transaction rolls the whole request
 * back.
 */

export type ScimAdmissionContext = {
  teamId: string;
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
  /** Bulk routes only; copied into each audit row's metadata. */
  batchId?: string;
};
export type ApproveTarget = { memberId: string; userId: string; expectedRole: TeamRole };
export type RejectTarget = { memberId: string; userId: string };

function admissionMetadata(ctx: ScimAdmissionContext, memberId: string, role: TeamRole) {
  return ctx.batchId === undefined ? { memberId, role } : { memberId, role, batchId: ctx.batchId };
}

/**
 * Admit the listed pending rows. Returns `null` when the actor may not act
 * (nothing written), else one outcome per target keyed by `memberId`.
 */
export async function approveScimPending(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ctx: ScimAdmissionContext,
  targets: readonly ApproveTarget[],
): Promise<Map<string, ScimApproveOutcome> | null> {
  const { teamId, actorUserId } = ctx;

  // Lock order (tenant-row-lock.ts): the actor's and every target's tenant
  // row (FOR SHARE) in one call, then the team — the only lock admission
  // shares with SCIM (lockGroupWrite) is the target's tenant-row advisory lock.
  const budget = createLockBudget();
  const rows = await lockTenantRows(tx, tenantId, [actorUserId, ...targets.map((t) => t.userId)], "share", budget);
  await lockTeamsAgainstRotation(tx, [teamId], budget);

  // The approver's authority as it stands now: active, and holding
  // MEMBER_INVITE (OWNER/ADMIN only) — a departure, removal or demotion
  // since the route's permission check ends it. Approve additionally needs
  // the current team key: rotation wraps only active distributed members, so
  // this is "holds the current key version". A leftover membership (the
  // approver left the tenant at or after their admission) holds no authority.
  const actor = await tx.teamMember.findFirst({
    where: { teamId, userId: actorUserId, deactivatedAt: null },
    select: { role: true, keyDistributed: true, admittedAt: true, createdAt: true },
  });
  if (
    !actor ||
    !hasTeamPermission(actor.role, TEAM_PERMISSION.MEMBER_INVITE) ||
    !actor.keyDistributed ||
    actorDepartedSinceAdmission(rows.get(actorUserId), actor.admittedAt ?? actor.createdAt)
  ) {
    return null;
  }

  const outcomes = new Map<string, ScimApproveOutcome>();
  for (const { memberId, userId, expectedRole } of targets) {
    // Locked re-read of the target: still pending. Checked before any
    // conflict below, so a row no longer pending (a concurrent approve/reject,
    // or a SCIM withdraw) is NOT_FOUND rather than a role/tenant conflict.
    // (Self-approval is ruled out structurally: the approver's row above is
    // active, and a pending row is always deactivated — no user can satisfy
    // both reads.)
    const locked = await tx.teamMember.findFirst({
      where: { id: memberId, teamId, userId, scimApprovalPending: true },
      select: { role: true },
    });
    if (!locked) {
      outcomes.set(memberId, SCIM_APPROVE_OUTCOME.NOT_FOUND);
      continue;
    }

    if (locked.role !== expectedRole) {
      outcomes.set(memberId, SCIM_APPROVE_OUTCOME.ROLE_CHANGED);
      continue;
    }

    const tenantRow = rows.get(userId);
    if (!tenantRow?.hasRow || tenantRow.deactivatedAt !== null) {
      outcomes.set(memberId, SCIM_APPROVE_OUTCOME.TENANT_INACTIVE);
      continue;
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
    // The CAS finding 0 rows is unreachable in practice once the checks above
    // pass under the same locks; kept as the defensive outcome.
    if (admitted.count !== 1) {
      outcomes.set(memberId, SCIM_APPROVE_OUTCOME.CAS_FAILED);
      continue;
    }

    await logAuditInTx(tx, tenantId, {
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.TEAM_MEMBER_SCIM_APPROVE,
      userId: actorUserId,
      tenantId,
      teamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: userId,
      metadata: admissionMetadata(ctx, memberId, expectedRole),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    outcomes.set(memberId, SCIM_APPROVE_OUTCOME.APPROVED);
  }
  return outcomes;
}

/**
 * Clear the listed pending rows. Returns `null` when the actor may not act
 * (nothing written), else one outcome per target keyed by `memberId`. Unlike
 * approve this hands nothing over: a team with no key-holding OWNER/ADMIN can
 * still reject.
 */
export async function rejectScimPending(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ctx: ScimAdmissionContext,
  targets: readonly RejectTarget[],
): Promise<Map<string, ScimRejectOutcome> | null> {
  const { teamId, actorUserId } = ctx;

  // Same lock order as approveScimPending.
  const budget = createLockBudget();
  await lockTenantRows(tx, tenantId, [actorUserId, ...targets.map((t) => t.userId)], "share", budget);
  await lockTeamsAgainstRotation(tx, [teamId], budget);

  // The actor's authority as it stands now: active, and holding
  // MEMBER_INVITE (OWNER/ADMIN only). No key requirement: a team without a
  // key holder can still clear requests.
  const actor = await tx.teamMember.findFirst({
    where: { teamId, userId: actorUserId, deactivatedAt: null },
    select: { role: true },
  });
  if (!actor || !hasTeamPermission(actor.role, TEAM_PERMISSION.MEMBER_INVITE)) {
    return null;
  }

  const outcomes = new Map<string, ScimRejectOutcome>();
  for (const { memberId, userId } of targets) {
    // Locked re-read of the target: still pending, for the audit row's role.
    // (Self-rejection is ruled out structurally: the actor's row above is
    // active, and a pending row is always deactivated.)
    const locked = await tx.teamMember.findFirst({
      where: { id: memberId, teamId, userId, scimApprovalPending: true },
      select: { role: true },
    });
    if (!locked) {
      outcomes.set(memberId, SCIM_REJECT_OUTCOME.NOT_FOUND);
      continue;
    }

    const removed = await tx.teamMember.deleteMany({
      where: { id: memberId, teamId, scimApprovalPending: true },
    });
    if (removed.count !== 1) {
      outcomes.set(memberId, SCIM_REJECT_OUTCOME.NOT_FOUND);
      continue;
    }

    await logAuditInTx(tx, tenantId, {
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.TEAM_MEMBER_SCIM_REJECT,
      userId: actorUserId,
      tenantId,
      teamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: userId,
      metadata: admissionMetadata(ctx, memberId, locked.role),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    outcomes.set(memberId, SCIM_REJECT_OUTCOME.REJECTED);
  }
  return outcomes;
}
