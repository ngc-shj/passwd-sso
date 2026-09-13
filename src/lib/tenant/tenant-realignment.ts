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
import { countStrandedRows, realignOwningTenantColumn } from "@/lib/tenant-context";
import { BYPASS_PURPOSE, withBypassRls } from "@/lib/tenant-rls";

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
 */
async function emitRealignment(
  tx: TxOrPrisma,
  r: {
    userId: string;
    memberId: string;
    previousTenantId: string;
    tenantId: string;
    leftBehind: Record<string, number>;
  },
): Promise<void> {
  const base = {
    userId: r.userId,
    actorType: ACTOR_TYPE.SYSTEM,
    scope: AUDIT_SCOPE.TENANT,
    // The MEMBERSHIP row, not the user id. Every other emitter of this
    // targetType keys on `tenant_members.id`, and an operator joining
    // `audit_logs.target_id` against it resolved nothing for exactly the event
    // that is their only handle on the stranded rows.
    targetType: AUDIT_TARGET_TYPE.TENANT_MEMBER,
  } as const;
  await logAuditInTx(tx as Prisma.TransactionClient, r.tenantId, {
    ...base,
    action: AUDIT_ACTION.USER_TENANT_REALIGNED,
    tenantId: r.tenantId,
    targetId: r.memberId,
    metadata: { previousTenantId: r.previousTenantId, leftBehind: r.leftBehind },
  });
  await logAuditInTx(tx as Prisma.TransactionClient, r.previousTenantId, {
    ...base,
    action: AUDIT_ACTION.USER_TENANT_REALIGNED,
    tenantId: r.previousTenantId,
    // No membership row of ours exists in the releasing tenant to point at —
    // the user id is what that tenant can still resolve against its own
    // deactivated membership.
    targetId: r.userId,
    metadata: { leftBehind: r.leftBehind },
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
  r: { userId: string; memberId: string; tenantId: string },
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
): Promise<string | null> {
  return withBypassRls(prisma, async (tx) => {
    const member = await tx.tenantMember.findFirst({
      where: { userId, tenantId, deactivatedAt: null },
      select: { id: true },
    });
    if (!member) return null;
    return realignToMembershipInTx(tx, { userId, memberId: member.id, tenantId });
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}
