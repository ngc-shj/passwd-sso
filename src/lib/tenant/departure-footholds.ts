import type { Prisma } from "@prisma/client";
import { logAuditBulkInTx } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import type { DepartureAuditActor } from "@/lib/team/team-departure";

/**
 * What a departed member minted that does not authenticate as the member and
 * so survives the credential revocation: service-account tokens they created
 * and admin vault resets they initiated that no other admin has approved yet
 * (docs/archive/review/member-foothold-containment-plan.md C4). Approved resets
 * stay: a present admin endorsed them.
 *
 * Called by every writer that ends a tenant membership, AFTER its credential
 * revocation (credential lock, then these rows;
 * scripts/checks/check-team-rotation-input-lock.mjs rule 9). MUST run inside a
 * transaction under the tenant's RLS context.
 */

export const FOOTHOLD_END_REASON = {
  CREATOR_DEPARTED: "CREATOR_DEPARTED",
  INITIATOR_DEPARTED: "INITIATOR_DEPARTED",
} as const;

type Tx = Prisma.TransactionClient;

export async function endCreatorFootholdsInTx(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
  actor: DepartureAuditActor,
): Promise<void> {
  if (userIds.length === 0) return;
  const now = new Date();
  const members = [...userIds];

  const tokens = await tx.serviceAccountToken.updateManyAndReturn({
    where: { tenantId, createdById: { in: members }, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
    select: { id: true, serviceAccountId: true, createdById: true },
  });
  const resets = await tx.adminVaultReset.updateManyAndReturn({
    where: {
      tenantId,
      initiatedById: { in: members },
      approvedAt: null,
      executedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { revokedAt: now, encryptedToken: null },
    select: { id: true, targetUserId: true, initiatedById: true },
  });

  await logAuditBulkInTx(
    tx,
    tenantId,
    tokens.map((token) => ({
      ...actor,
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_REVOKE,
      tenantId,
      targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT_TOKEN,
      targetId: token.id,
      metadata: {
        serviceAccountId: token.serviceAccountId,
        targetUserId: token.createdById,
        reason: FOOTHOLD_END_REASON.CREATOR_DEPARTED,
      },
    })),
  );
  await logAuditBulkInTx(
    tx,
    tenantId,
    resets.map((reset) => ({
      ...actor,
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.ADMIN_VAULT_RESET_REVOKE,
      tenantId,
      targetType: "User",
      targetId: reset.targetUserId,
      metadata: {
        resetId: reset.id,
        initiatedById: reset.initiatedById,
        reason: FOOTHOLD_END_REASON.INITIATOR_DEPARTED,
      },
    })),
  );
}
