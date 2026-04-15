import type { Prisma, AuditScope, AuditAction, ActorType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { NIL_UUID } from "@/lib/constants/app";

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
  const [ctx] = await tx.$queryRaw<{ bypass_rls: string; tenant_id: string }[]>`
    SELECT current_setting('app.bypass_rls', true) AS bypass_rls,
           current_setting('app.tenant_id', true)  AS tenant_id`;
  if (ctx.bypass_rls !== "on" && ctx.tenant_id !== tenantId) {
    throw new Error(
      `enqueueAuditInTx called outside withBypassRls/withTenantRls scope; ` +
      `bypass_rls=${ctx.bypass_rls}, tenant_id=${ctx.tenant_id}, expected=${tenantId}`,
    );
  }
  const [tenantExists] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantId}::uuid) AS ok`;
  if (!tenantExists?.ok) {
    throw new Error(
      `enqueueAuditInTx: tenantId ${tenantId} does not exist`,
    );
  }
  await tx.auditOutbox.create({
    data: {
      tenantId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function enqueueAudit(
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.bypass_purpose', ${BYPASS_PURPOSE.AUDIT_WRITE}, true)`;
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${NIL_UUID}, true)`;
    await enqueueAuditInTx(tx, tenantId, payload);
  });
}
