import type { Prisma } from "@prisma/client";
// `prismaBase`, not `prisma`. The exported `prisma` is a Proxy: while an RLS
// context is active its `$transaction` arm does not open a transaction, it
// invokes the callback with the OUTER transaction client. The three
// `set_config` calls below would then land on the caller's transaction and,
// because PostgreSQL does not roll a transaction-local GUC back when an
// AsyncLocalStorage scope exits, leave it running with `app.bypass_rls` on for
// its remainder. Opening on the un-proxied client makes that structurally
// impossible rather than conventionally avoided.
import { prismaBase } from "@/lib/prisma";
import { BYPASS_GRANT, readBypassState, setBypassGucs } from "@/lib/tenant-rls-grants";

import { enqueueAuditInTx as enqueueAuditRowInTx, type AuditOutboxPayload } from "@/lib/audit/audit-outbox-in-tx";

export type { AuditOutboxPayload };

/**
 * Enqueue one audit outbox row on the caller's transaction. The implementation is
 * `audit-outbox-in-tx.ts`'s; it stays exported from here, as a function of this
 * module, because application callers import it from here and a test spies on
 * this export.
 */
export async function enqueueAuditInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<void> {
  await enqueueAuditRowInTx(tx, tenantId, payload);
}

export async function enqueueAudit(
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<void> {
  await prismaBase.$transaction(async (tx) => {
    await setBypassGucs(tx, BYPASS_GRANT.AUDIT_OUTBOX_ENQUEUE);
    await enqueueAuditInTx(tx, tenantId, payload);
  });
}

/**
 * Enqueue many audit outbox rows in a single transaction.
 * Used by bulk operations to avoid N sequential round-trips.
 * All payloads must belong to the same tenant.
 */
export async function enqueueAuditBulk(
  tenantId: string,
  payloads: AuditOutboxPayload[],
): Promise<void> {
  if (payloads.length === 0) return;
  await prismaBase.$transaction(async (tx) => {
    await setBypassGucs(tx, BYPASS_GRANT.AUDIT_OUTBOX_ENQUEUE);
    if ((await readBypassState(tx))?.bypassRls !== "on") {
      throw new Error("enqueueAuditBulk: bypass_rls context not active");
    }
    const [tenantExists] = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantId}::uuid) AS ok`;
    if (!tenantExists?.ok) {
      throw new Error(`enqueueAuditBulk: tenantId ${tenantId} does not exist`);
    }
    await tx.auditOutbox.createMany({
      data: payloads.map((payload) => ({
        tenantId,
        payload: payload as unknown as Prisma.InputJsonValue,
      })),
    });
  });
}
