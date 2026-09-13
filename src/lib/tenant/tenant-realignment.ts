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
 * `realignOwningTenantColumn` for why that is the decision. The move and its record
 * are `tenant-realignment-core.ts`'s, shared with the offline operator CLI.
 */

import { prisma, type TxOrPrisma } from "@/lib/prisma";
import { logAuditInTx } from "@/lib/audit/audit";
import { countStrandedRows, realignOwningTenantColumn } from "@/lib/tenant-context";
import { BYPASS_PURPOSE, withBypassRls } from "@/lib/tenant-rls";
import { realignToMembershipInTxWith, type RealignmentCause } from "@/lib/tenant/tenant-realignment-core";

export {
  REALIGNMENT_SOURCE,
  realignmentBySignIn,
  type RealignmentCause,
  type RealignmentSource,
} from "@/lib/tenant/tenant-realignment-core";

/**
 * Point the column at `tenantId`, the tenant of membership `memberId`, and record
 * the move — inside a transaction that can write the user's row (a bypass). See
 * `realignToMembershipInTxWith` for the move and its record.
 *
 * The application's dependencies are named at each call, not captured once, so a
 * test that mocks `@/lib/audit/audit` or `@/lib/tenant-context` reaches this path.
 */
export async function realignToMembershipInTx(
  tx: TxOrPrisma,
  r: { userId: string; memberId: string; tenantId: string; cause: RealignmentCause },
): Promise<string | null> {
  return realignToMembershipInTxWith({ logAuditInTx, realignOwningTenantColumn, countStrandedRows }, tx, r);
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
