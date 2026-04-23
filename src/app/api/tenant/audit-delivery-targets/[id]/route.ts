import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit";
import { assertOrigin } from "@/lib/csrf";
import { parseBody } from "@/lib/parse-body";
import {
  TENANT_PERMISSION,
  AUDIT_ACTION,
} from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { handleAuthError, notFound, unauthorized } from "@/lib/api-response";
import { z } from "zod";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  isActive: z.boolean(),
});

// PATCH /api/tenant/audit-delivery-targets/[id] — Toggle isActive for an audit delivery target
async function handlePATCH(req: NextRequest, { params }: Params) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }

  const result = await parseBody(req, patchSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  const target = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.auditDeliveryTarget.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true, kind: true, isActive: true },
    }),
  );

  if (!target) {
    return notFound();
  }

  // No-op guard: skip update + audit log if isActive is already the requested value
  if (target.isActive === data.isActive) {
    return NextResponse.json({ success: true, target: { id, kind: target.kind, isActive: target.isActive } });
  }

  const updated = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.auditDeliveryTarget.update({
      where: { id, tenantId: actor.tenantId },
      data: { isActive: data.isActive },
    }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: data.isActive
      ? AUDIT_ACTION.AUDIT_DELIVERY_TARGET_REACTIVATE
      : AUDIT_ACTION.AUDIT_DELIVERY_TARGET_DEACTIVATE,
    metadata: { targetId: id, kind: target.kind },
  });

  return NextResponse.json({ success: true, target: { id, kind: updated.kind, isActive: updated.isActive } });
}

export const PATCH = withRequestLog(handlePATCH);
