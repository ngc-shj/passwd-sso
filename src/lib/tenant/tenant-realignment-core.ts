/**
 * The realignment itself — moving `User.tenantId` onto a membership and recording
 * the move for both tenants — with its I/O handed in rather than imported.
 *
 * Split from `tenant-realignment.ts` because two very different processes run it.
 * The application passes the audit writer and column helpers its own callers and
 * tests already mock. The offline operator CLI (`scripts/tenant-domain.ts
 * realign`) runs on `MIGRATION_DATABASE_URL` alone and passes implementations
 * that never reach the application's Prisma singleton, which throws at import
 * without `DATABASE_URL` (round-7 F-R7-2). One implementation of the move and its
 * record, so the two cannot drift.
 */

import type { Prisma } from "@prisma/client";
import type { TxOrPrisma } from "@/lib/prisma";
import type { AuditLogParams } from "@/lib/audit/audit-payload";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

/** Which producer moved the column, recorded on both tenants' rows. */
export const REALIGNMENT_SOURCE = {
  SIGN_IN: "sign_in",
  SCIM: "scim",
  DIRECTORY_SYNC: "directory_sync",
  /** `tenant-domain realign`: a deployment operator, for a user no producer may move. */
  OPERATOR: "operator",
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
  /** The user on sign-in; the SCIM token's audit user; the sync's actor; the system for an operator. */
  actorUserId: string;
  actorType: (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE];
  /** An operator's self-asserted `--by` label, recorded as `by` on both rows. */
  label?: string;
}

/** A sign-in's own realignment: the user acted, as recorded before causes existed. */
export function realignmentBySignIn(userId: string): RealignmentCause {
  return { source: REALIGNMENT_SOURCE.SIGN_IN, actorUserId: userId, actorType: ACTOR_TYPE.SYSTEM };
}

/** The I/O a realignment performs, supplied by the process running it. */
export interface RealignmentDeps {
  logAuditInTx(tx: Prisma.TransactionClient, tenantId: string, params: AuditLogParams): Promise<void>;
  realignOwningTenantColumn(db: Pick<Prisma.TransactionClient, "user">, userId: string, tenantId: string): Promise<string | null>;
  countStrandedRows(db: Prisma.TransactionClient, userId: string, tenantId: string): Promise<Record<string, number>>;
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
 * command (`tenant-domain realign`), are the producers that move a column in the
 * ordinary course.
 */
async function emitRealignment(
  deps: RealignmentDeps,
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
  // An operator's self-asserted label, on both rows: the system actor says the
  // move was not a principal of either tenant, and the label says who ran it.
  const by = r.cause.label ? { by: r.cause.label } : {};
  const releasingActor =
    r.cause.source === REALIGNMENT_SOURCE.SIGN_IN
      ? { userId: r.cause.actorUserId, actorType: r.cause.actorType }
      : { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM };
  await deps.logAuditInTx(tx as Prisma.TransactionClient, r.tenantId, {
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
      ...by,
    },
  });
  await deps.logAuditInTx(tx as Prisma.TransactionClient, r.previousTenantId, {
    ...base,
    ...releasingActor,
    action: AUDIT_ACTION.USER_TENANT_REALIGNED,
    tenantId: r.previousTenantId,
    // No membership row of ours exists in the releasing tenant to point at —
    // the user id is what that tenant can still resolve against its own
    // deactivated membership.
    targetId: r.userId,
    metadata: { leftBehind: r.leftBehind, source: r.cause.source, ...by },
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
export async function realignToMembershipInTxWith(
  deps: RealignmentDeps,
  tx: TxOrPrisma,
  r: { userId: string; memberId: string; tenantId: string; cause: RealignmentCause },
): Promise<string | null> {
  const previousTenantId = await deps.realignOwningTenantColumn(tx as Prisma.TransactionClient, r.userId, r.tenantId);
  if (!previousTenantId) return null;
  const leftBehind = await deps.countStrandedRows(tx as Prisma.TransactionClient, r.userId, previousTenantId);
  await emitRealignment(deps, tx, { ...r, previousTenantId, leftBehind });
  return previousTenantId;
}
