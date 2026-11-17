import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { parseBody } from "@/lib/http/parse-body";
import {
  TENANT_PERMISSION,
  AUDIT_ACTION,
} from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { lockFootholdWriter } from "@/lib/tenant/foothold-write-gate";
import { footholdWriteErrorResponse } from "@/lib/http/lock-conflict-response";
import { z } from "zod";
import { AuditDeliveryStatus } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  isActive: z.boolean(),
});

// PATCH /api/tenant/audit-delivery-targets/[id] — Toggle isActive for an audit delivery target
async function handlePATCH(req: NextRequest, { params }: Params) {
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

  // @stepup id:audit-delivery-target-id-patch method:PATCH
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const result = await parseBody(req, patchSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Both directions are gated: re-activating undoes a containment, and
  // deactivating a SIEM target removes visibility, so neither is a pure
  // narrowing. The gate precedes the read so a demoted actor learns nothing
  // (not even the no-op answer) about a target.
  let outcome;
  try {
    outcome = await withTenantRls(prisma, actor.tenantId, async (tx) => {
      await lockFootholdWriter(tx, req, {
        tenantId: actor.tenantId,
        actorId: session.user.id,
        permission: TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE,
      });
      const target = await tx.auditDeliveryTarget.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { id: true, kind: true, isActive: true },
      });
      if (!target) return null;
      // No-op guard: skip update + audit log if isActive is already the requested value
      if (target.isActive === data.isActive) return { target, pendingDeliveries: null };
      await tx.auditDeliveryTarget.update({
        where: { id, tenantId: actor.tenantId },
        data: { isActive: data.isActive },
      });
      // The queued deliveries this toggle parks (deactivate) or releases
      // (reactivate), recorded so the change of what reaches the destination
      // is visible in the audit row.
      const pendingDeliveries = await tx.auditDelivery.count({
        where: { tenantId: actor.tenantId, targetId: id, status: AuditDeliveryStatus.PENDING },
      });
      return { target, pendingDeliveries };
    });
  } catch (e) {
    const footholdResponse = footholdWriteErrorResponse(e);
    if (footholdResponse) return footholdResponse;
    throw e;
  }

  if (!outcome) {
    return notFound();
  }
  const { kind } = outcome.target;
  const { pendingDeliveries } = outcome;
  if (pendingDeliveries === null) {
    return NextResponse.json({ success: true, target: { id, kind, isActive: outcome.target.isActive } });
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: data.isActive
      ? AUDIT_ACTION.AUDIT_DELIVERY_TARGET_REACTIVATE
      : AUDIT_ACTION.AUDIT_DELIVERY_TARGET_DEACTIVATE,
    metadata: { targetId: id, kind, pendingDeliveries },
  });

  return NextResponse.json({ success: true, target: { id, kind, isActive: data.isActive } });
}

export const PATCH = withRequestLog(handlePATCH);
