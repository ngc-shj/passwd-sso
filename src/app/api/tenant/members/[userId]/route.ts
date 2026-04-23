import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit";
import { updateTenantMemberRoleSchema } from "@/lib/validations";
import {
  requireTenantPermission,
} from "@/lib/auth/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TENANT_PERMISSION, TENANT_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";

export const runtime = "nodejs";

type Params = { params: Promise<{ userId: string }> };

// PUT /api/tenant/members/[userId] — Change tenant member role
async function handlePUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId } = await params;

  // Permission gate
  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.MEMBER_MANAGE,
    );
  } catch (e) {
    return handleAuthError(e);
  }

  // Only OWNER can change roles
  if (actor.role !== TENANT_ROLE.OWNER) {
    return NextResponse.json(
      { error: API_ERROR.OWNER_ONLY },
      { status: 403 },
    );
  }

  // Cannot change own role — must be before ownership transfer
  if (userId === session.user.id) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_CHANGE_OWN_ROLE },
      { status: 400 },
    );
  }

  // Validate request body
  const result = await parseBody(req, updateTenantMemberRoleSchema);
  if (!result.ok) return result.response;

  // Look up target with explicit tenantId filter (defense-in-depth)
  const target = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantMember.findFirst({
      where: {
        userId,
        tenantId: actor.tenantId,
        deactivatedAt: null,
      },
    }),
  );

  if (!target) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND, 404);
  }

  // SCIM guard
  if (target.scimManaged) {
    return NextResponse.json(
      { error: API_ERROR.SCIM_MANAGED_MEMBER },
      { status: 409 },
    );
  }

  // Ownership transfer
  if (result.data.role === TENANT_ROLE.OWNER) {
    const updated = await withTenantRls(prisma, actor.tenantId, async () => {
      // Re-verify actor is still OWNER inside RLS scope
      const currentActor = await prisma.tenantMember.findFirst({
        where: { userId: session.user!.id, tenantId: actor.tenantId, role: TENANT_ROLE.OWNER },
      });
      if (!currentActor) {
        return null;
      }

      // Demote actor first (avoid transient dual-OWNER)
      await prisma.tenantMember.update({
        where: { id: currentActor.id },
        data: { role: TENANT_ROLE.ADMIN },
      });

      // Promote target to OWNER
      return prisma.tenantMember.update({
        where: { id: target.id },
        data: { role: TENANT_ROLE.OWNER },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      });
    });

    if (!updated) {
      return NextResponse.json(
        { error: API_ERROR.OWNER_ONLY },
        { status: 403 },
      );
    }

    await logAuditAsync({
      ...tenantAuditBase(req, session.user.id, actor.tenantId),
      action: AUDIT_ACTION.TENANT_ROLE_UPDATE,
      targetType: AUDIT_TARGET_TYPE.TENANT_MEMBER,
      targetId: target.id,
      metadata: { newRole: TENANT_ROLE.OWNER, previousRole: target.role, transfer: true },
    });

    return NextResponse.json({
      id: updated.id,
      userId: updated.userId,
      role: updated.role,
      name: updated.user.name,
      email: updated.user.email,
      image: updated.user.image,
    });
  }

  // Cannot change OWNER role (non-transfer)
  if (target.role === TENANT_ROLE.OWNER) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_CHANGE_OWNER_ROLE },
      { status: 403 },
    );
  }

  // Update role
  const updated = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantMember.update({
      where: { id: target.id },
      data: { role: result.data.role },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.TENANT_ROLE_UPDATE,
    targetType: AUDIT_TARGET_TYPE.TENANT_MEMBER,
    targetId: target.id,
    metadata: { newRole: result.data.role, previousRole: target.role },
  });

  return NextResponse.json({
    id: updated.id,
    userId: updated.userId,
    role: updated.role,
    name: updated.user.name,
    email: updated.user.email,
    image: updated.user.image,
  });
}

export const PUT = withRequestLog(handlePUT);
