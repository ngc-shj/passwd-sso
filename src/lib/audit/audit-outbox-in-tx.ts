/**
 * The audit outbox write that runs on a transaction the caller already holds, in
 * a module that never reaches the application's Prisma singleton.
 *
 * `@/lib/prisma` builds the application pool when it is imported and throws when
 * `DATABASE_URL` is unset, and `audit-outbox.ts` imports it for the enqueues that
 * open their own transaction. The offline operator CLI (`scripts/tenant-domain.ts
 * realign`) runs on `MIGRATION_DATABASE_URL` alone and writes its audit rows on
 * its own transaction, so it imports this module instead (round-7 F-R7-2).
 * `audit-outbox.ts` re-exposes the function under the same name, which is where
 * every application caller and test reaches it.
 */
import type { Prisma, AuditScope, AuditAction, ActorType } from "@prisma/client";
import { readBypassState } from "@/lib/tenant-rls-grants";

export interface AuditOutboxPayload {
  scope: AuditScope;
  action: AuditAction;
  userId: string;
  actorType: ActorType;
  serviceAccountId: string | null;
  teamId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

export async function enqueueAuditInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<void> {
  const ctx = await readBypassState(tx);
  if (!ctx || (ctx.bypassRls !== "on" && ctx.tenantId !== tenantId)) {
    throw new Error(
      `enqueueAuditInTx called outside withBypassRls/withTenantRls scope; ` +
      `bypass_rls=${ctx?.bypassRls}, tenant_id=${ctx?.tenantId}, expected=${tenantId}`,
    );
  }
  // No tenant-existence probe here (C4): `audit_outbox_tenant_id_fkey` is not
  // DEFERRABLE, so it is checked at this INSERT, in the same transaction, and
  // referential-integrity checks bypass row security (PostgreSQL docs, "Row
  // Security Policies") — an unknown tenantId rejects on the FK regardless of
  // which grant this call runs under, including one that does not name
  // `tenants`.
  await tx.auditOutbox.create({
    data: {
      tenantId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}
