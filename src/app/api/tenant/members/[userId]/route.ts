import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { updateTenantMemberRoleSchema } from "@/lib/validations";
import {
  requireTenantPermission,
} from "@/lib/auth/access/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TENANT_PERMISSION, TENANT_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { createLockBudget } from "@/lib/team/team-key-rotation-lock";
import { isMembershipLockConflict, lockTenantRows } from "@/lib/team/tenant-row-lock";
import { withRequestLog } from "@/lib/http/with-request-log";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";

export const runtime = "nodejs";

const ROLE_CHANGE_OUTCOME = {
  UPDATED: "updated",
  ACTOR_NOT_OWNER: "actor_not_owner",
  NOT_FOUND: "not_found",
  SCIM_MANAGED: "scim_managed",
  TARGET_IS_OWNER: "target_is_owner",
} as const;

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
    return errorResponse(API_ERROR.OWNER_ONLY);
  }

  // @stepup id:tenant-member-put method:PUT
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  // Cannot change own role — must be before ownership transfer
  if (userId === session.user.id) {
    return errorResponse(API_ERROR.CANNOT_CHANGE_OWN_ROLE);
  }

  // Validate request body
  const result = await parseBody(req, updateTenantMemberRoleSchema);
  if (!result.ok) return result.response;

  const newRole = result.data.role;
  const memberSelect = {
    user: { select: { id: true, name: true, email: true, image: true } },
  } as const;

  // Every read the decision rests on — the actor still OWNER, the target
  // active, not SCIM-managed, not already OWNER — is made under the actor's
  // and the target's tenant rows (FOR UPDATE, tenant-row-lock.ts), the lock a
  // concurrent transfer, role change or SCIM deactivation of either also
  // takes. Without it two concurrent transfers leave two OWNERs, and a
  // transfer racing a role change of its target leaves none.
  let outcome;
  try {
    outcome = await withTenantRls(prisma, actor.tenantId, async (tx) => {
      const budget = createLockBudget();
      const rows = await lockTenantRows(tx, actor.tenantId, [session.user!.id, userId], "update", budget);
      const actorRow = rows.get(session.user!.id);
      if (actorRow?.role !== TENANT_ROLE.OWNER || actorRow.deactivatedAt !== null) {
        return { status: ROLE_CHANGE_OUTCOME.ACTOR_NOT_OWNER };
      }

      // Look up target with explicit tenantId filter (defense-in-depth)
      const target = await tx.tenantMember.findFirst({
        where: {
          userId,
          tenantId: actor.tenantId,
          deactivatedAt: null,
        },
      });
      if (!target) return { status: ROLE_CHANGE_OUTCOME.NOT_FOUND };
      // SCIM guard
      if (target.scimManaged) return { status: ROLE_CHANGE_OUTCOME.SCIM_MANAGED };

      // Ownership transfer
      if (newRole === TENANT_ROLE.OWNER) {
        // Demote actor first (avoid transient dual-OWNER)
        await tx.tenantMember.updateMany({
          where: { userId: session.user!.id, tenantId: actor.tenantId, role: TENANT_ROLE.OWNER },
          data: { role: TENANT_ROLE.ADMIN },
        });
        const updated = await tx.tenantMember.update({
          where: { id: target.id, tenantId: actor.tenantId },
          data: { role: TENANT_ROLE.OWNER },
          include: memberSelect,
        });
        return { status: ROLE_CHANGE_OUTCOME.UPDATED, updated, previousRole: target.role };
      }

      // Cannot change OWNER role (non-transfer)
      if (target.role === TENANT_ROLE.OWNER) return { status: ROLE_CHANGE_OUTCOME.TARGET_IS_OWNER };

      const updated = await tx.tenantMember.update({
        where: { id: target.id, tenantId: actor.tenantId },
        data: { role: newRole },
        include: memberSelect,
      });
      return { status: ROLE_CHANGE_OUTCOME.UPDATED, updated, previousRole: target.role };
    });
  } catch (e) {
    if (isMembershipLockConflict(e)) return errorResponse(API_ERROR.CONFLICT);
    throw e;
  }

  if (outcome.status === ROLE_CHANGE_OUTCOME.ACTOR_NOT_OWNER) return errorResponse(API_ERROR.OWNER_ONLY);
  if (outcome.status === ROLE_CHANGE_OUTCOME.NOT_FOUND) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  if (outcome.status === ROLE_CHANGE_OUTCOME.SCIM_MANAGED) return errorResponse(API_ERROR.SCIM_MANAGED_MEMBER);
  if (outcome.status === ROLE_CHANGE_OUTCOME.TARGET_IS_OWNER) return errorResponse(API_ERROR.CANNOT_CHANGE_OWNER_ROLE);

  const { updated, previousRole } = outcome;
  const transfer = newRole === TENANT_ROLE.OWNER;
  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.TENANT_ROLE_UPDATE,
    targetType: AUDIT_TARGET_TYPE.TENANT_MEMBER,
    targetId: updated.id,
    metadata: transfer ? { newRole, previousRole, transfer: true } : { newRole, previousRole },
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
