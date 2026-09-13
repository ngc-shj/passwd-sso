/**
 * Moving `User.tenantId` with the membership a producer activates, and recording
 * every move.
 *
 * `User.tenantId` is a denormalized copy of the user's active membership, and every
 * `users`-row read under a tenant context depends on it: `users_tenant_isolation`
 * shows a row only to the tenant the column names. A producer that activates a
 * membership without moving the column leaves the user's own requests unable to see
 * their own row, and the tenant they joined unable to read them. Sign-in joining a
 * claimed tenant did this until it was fixed there; SCIM provisioning and
 * reactivation and directory sync still did. They share this module so the move and
 * its record cannot drift apart between them.
 *
 * The move leaves the user's data where it is and reports what it left behind — see
 * `realignOwningTenantColumn` for why that is the decision.
 */

import type { Prisma } from "@prisma/client";
import { prisma, type TxOrPrisma } from "@/lib/prisma";
import { logAuditInTx } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { countStrandedRows, realignOwningTenantColumn } from "@/lib/tenant-context";
import { BYPASS_PURPOSE, withBypassRls } from "@/lib/tenant-rls";

/** Which producer moved the column, recorded on both tenants' rows. */
export const REALIGNMENT_SOURCE = {
  SIGN_IN: "sign_in",
  SCIM: "scim",
  DIRECTORY_SYNC: "directory_sync",
} as const;

export type RealignmentSource = (typeof REALIGNMENT_SOURCE)[keyof typeof REALIGNMENT_SOURCE];

/**
 * Who caused a realignment, and through which producer (round-5 S2): recording the
 * moved user as the actor for every producer told neither tenant whether the user
 * signed in elsewhere or another tenant's provisioning moved them.
 *
 * The actor is recorded only where it is a principal of the tenant reading the
 * row — see `emitRealignment`.
 */
export interface RealignmentCause {
  source: RealignmentSource;
  /** The user on sign-in; the SCIM token's audit user; the sync's actor or the system. */
  actorUserId: string;
  actorType: (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE];
}

/** A sign-in's own realignment: the user acted, as recorded before causes existed. */
export function realignmentBySignIn(userId: string): RealignmentCause {
  return { source: REALIGNMENT_SOURCE.SIGN_IN, actorUserId: userId, actorType: ACTOR_TYPE.SYSTEM };
}

/**
 * Record a realignment, on the transaction that performed it.
 *
 * `logAuditInTx`, NOT `logAuditAsync`. An earlier version carried the fact out
 * of the transaction and emitted at the callback, justified by "emitting inside
 * would run logAuditAsync -> resolveTenantId -> withBypassRls NESTED inside the
 * enclosing bypass". That reason is FALSE for this call shape: `resolveTenantId`
 * returns on its first line when `params.tenantId` is set, and it is set here.
 * What actually refuses `logAuditAsync` in an RLS context is
 * `refuseIfInsideRlsContext`, whose own docstring names `logAuditInTx` as the
 * in-context path — so the false reason was closing off the option that makes
 * the record atomic with the tenancy move it reports. The design decision
 * (`docs/archive/review/audit-tenant-adjudicator-design.md`) stakes option 3
 * entirely on that record existing; a crash between commit and a post-hoc
 * enqueue would have lost it.
 *
 * TWO rows, one per tenant. The joining tenant's operators hold the member and
 * can act; the RELEASING tenant keeps the data and, until this, was told nothing
 * at all while its own member list broke. Their row carries no id of the tenant
 * the user went to — that tenant's identity is not theirs to learn, the same
 * line the directory-sync refusal draws.
 *
 * Nor its people. For SCIM and directory sync the actor is the joining tenant's
 * token creator or sync admin, and every reader of the releasing tenant's log —
 * the audit-log view and its download hydrate an actor id into name and email
 * with no tenant check, and webhooks deliver the id — would hand them that
 * person, whose email names the tenant anyway (round-6 R6-S1). The releasing row
 * therefore records the system as actor and keeps `source`, which alone answers
 * its question. A sign-in is the one cause whose actor is the moved user, a
 * principal the releasing tenant already knows, so it keeps them.
 *
 * Since round 6, SCIM and directory sync realign only a user this tenant already
 * owns, so a releasing row from them arises only when ownership changed between
 * their check and their commit (round-7 F-R7-5). Sign-in, and the operator
 * command, are the producers that move a column in the ordinary course.
 */
async function emitRealignment(
  tx: TxOrPrisma,
  r: {
    userId: string;
    memberId: string;
    previousTenantId: string;
    tenantId: string;
    leftBehind: Record<string, number>;
    cause: RealignmentCause;
  },
): Promise<void> {
  const base = {
    scope: AUDIT_SCOPE.TENANT,
    // The MEMBERSHIP row, not the user id. Every other emitter of this
    // targetType keys on `tenant_members.id`, and an operator joining
    // `audit_logs.target_id` against it resolved nothing for exactly the event
    // that is their only handle on the stranded rows.
    targetType: AUDIT_TARGET_TYPE.TENANT_MEMBER,
  } as const;
  const releasingActor =
    r.cause.source === REALIGNMENT_SOURCE.SIGN_IN
      ? { userId: r.cause.actorUserId, actorType: r.cause.actorType }
      : { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM };
  await logAuditInTx(tx as Prisma.TransactionClient, r.tenantId, {
    ...base,
    userId: r.cause.actorUserId,
    actorType: r.cause.actorType,
    action: AUDIT_ACTION.USER_TENANT_REALIGNED,
    tenantId: r.tenantId,
    targetId: r.memberId,
    metadata: {
      previousTenantId: r.previousTenantId,
      leftBehind: r.leftBehind,
      source: r.cause.source,
      movedUserId: r.userId,
    },
  });
  await logAuditInTx(tx as Prisma.TransactionClient, r.previousTenantId, {
    ...base,
    ...releasingActor,
    action: AUDIT_ACTION.USER_TENANT_REALIGNED,
    tenantId: r.previousTenantId,
    // No membership row of ours exists in the releasing tenant to point at —
    // the user id is what that tenant can still resolve against its own
    // deactivated membership.
    targetId: r.userId,
    metadata: { leftBehind: r.leftBehind, source: r.cause.source },
  });
}

/**
 * Point the column at `tenantId`, the tenant of membership `memberId`, and record
 * the move — inside a transaction that can write the user's row (a bypass).
 *
 * Returns the tenant the column named before, or null when it already named
 * `tenantId` and nothing was written or recorded — the ordinary case, which costs
 * one read.
 */
export async function realignToMembershipInTx(
  tx: TxOrPrisma,
  r: { userId: string; memberId: string; tenantId: string; cause: RealignmentCause },
): Promise<string | null> {
  const previousTenantId = await realignOwningTenantColumn(tx, r.userId, r.tenantId);
  if (!previousTenantId) return null;
  const leftBehind = await countStrandedRows(tx as Prisma.TransactionClient, r.userId, previousTenantId);
  await emitRealignment(tx, { ...r, previousTenantId, leftBehind });
  return previousTenantId;
}

/**
 * The same, for a producer that activated the membership inside a TENANT context,
 * which cannot write a users row the column files under another tenant. Call it
 * after that context has committed: it opens its own bypass, so the move is not
 * atomic with the activation.
 *
 * The membership is re-read under the bypass and followed only while it is still
 * ACTIVE in `tenantId`, so a deactivation that lands in between is not undone by
 * moving the column back onto a tenant the user has left.
 */
export async function realignAfterActivation(
  userId: string,
  tenantId: string,
  cause: RealignmentCause,
): Promise<string | null> {
  return withBypassRls(prisma, async (tx) => {
    const member = await tx.tenantMember.findFirst({
      where: { userId, tenantId, deactivatedAt: null },
      select: { id: true },
    });
    if (!member) return null;
    return realignToMembershipInTx(tx, { userId, memberId: member.id, tenantId, cause });
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}
