import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import {
  TENANT_PERMISSION,
  AUDIT_ACTION,
} from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { handleAuthError, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ webhookId: string }> };

// DELETE /api/tenant/webhooks/[webhookId] — Delete a tenant webhook
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { webhookId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.WEBHOOK_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }

  const webhook = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantWebhook.findFirst({
      where: { id: webhookId, tenantId: actor.tenantId },
      select: { id: true, url: true },
    }),
  );

  if (!webhook) {
    return notFound();
  }

  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantWebhook.delete({ where: { id: webhookId, tenantId: actor.tenantId } }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.TENANT_WEBHOOK_DELETE,
    metadata: { webhookId, url: webhook.url },
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
