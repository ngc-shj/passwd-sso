import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateScimToken } from "@/lib/scim-token";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import { userToScimUser, type ScimUserInput } from "@/lib/scim/serializers";
import { scimUserSchema, scimPatchOpSchema } from "@/lib/scim/validations";
import { parseUserPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import type { AuditAction } from "@prisma/client";
import { ORG_ROLE, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";

type Params = { params: Promise<{ id: string }> };

/** Resolve SCIM id → userId. The id could be a userId directly or via ScimExternalMapping. */
async function resolveUserId(
  orgId: string,
  tenantId: string,
  scimId: string,
): Promise<string | null> {
  if (scimId.length > 255) return null;

  // First try as direct userId (OrgMember.userId)
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId: scimId } },
    select: { userId: true },
  });
  if (member) return member.userId;

  // Try via ScimExternalMapping (scimId may be an externalId from the IdP)
  const mapping = await prisma.scimExternalMapping.findFirst({
    where: {
      tenantId,
      externalId: scimId,
      resourceType: "User",
    },
    select: { internalId: true },
  });
  return mapping?.internalId ?? null;
}

async function fetchUserResource(
  orgId: string,
  tenantId: string,
  userId: string,
  baseUrl: string,
) {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!member || !member.user.email) return null;

  const extMapping = await prisma.scimExternalMapping.findFirst({
    where: {
      tenantId,
      internalId: userId,
      resourceType: "User",
    },
    select: { externalId: true },
  });

  const input: ScimUserInput = {
    userId: member.userId,
    email: member.user.email,
    name: member.user.name,
    deactivatedAt: member.deactivatedAt,
    externalId: extMapping?.externalId,
  };

  return userToScimUser(input, baseUrl);
}

// GET /api/scim/v2/Users/[id]
export async function GET(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { orgId, tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const { id } = await params;
  const userId = await resolveUserId(orgId, tenantId, id);
  if (!userId) {
    return scimError(404, "User not found");
  }

  const baseUrl = getScimBaseUrl();
  const resource = await fetchUserResource(orgId, tenantId, userId, baseUrl);
  if (!resource) {
    return scimError(404, "User not found");
  }

  return scimResponse(resource);
}

// PUT /api/scim/v2/Users/[id] — Full replace (update OrgMember attributes only)
export async function PUT(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { orgId, tenantId, auditUserId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const { id } = await params;
  const userId = await resolveUserId(orgId, tenantId, id);
  if (!userId) {
    return scimError(404, "User not found");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON");
  }

  const parsed = scimUserSchema.safeParse(body);
  if (!parsed.success) {
    return scimError(400, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { active, externalId, name } = parsed.data;

  // OWNER protection
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { id: true, role: true, deactivatedAt: true, userId: true },
  });
  if (!member) {
    return scimError(404, "User not found");
  }
  if (member.role === ORG_ROLE.OWNER && active === false) {
    return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
  }

  // Determine audit action based on active state change
  let auditAction: AuditAction = AUDIT_ACTION.SCIM_USER_UPDATE;
  if (active === false && member.deactivatedAt === null) {
    auditAction = AUDIT_ACTION.SCIM_USER_DEACTIVATE;
  } else if (active !== false && member.deactivatedAt !== null) {
    auditAction = AUDIT_ACTION.SCIM_USER_REACTIVATE;
  }

  // Atomic update: OrgMember + externalId mapping
  try {
    await prisma.$transaction(async (tx) => {
      // Update OrgMember attributes
      await tx.orgMember.update({
        where: { id: member.id },
        data: {
          deactivatedAt: active === false ? (member.deactivatedAt ?? new Date()) : null,
          scimManaged: true,
        },
      });

      // Update external mapping if provided; clear if omitted (PUT = full replace)
      if (externalId) {
        const existingMapping = await tx.scimExternalMapping.findFirst({
          where: {
            tenantId,
            externalId,
            resourceType: "User",
          },
        });
        if (existingMapping && existingMapping.internalId !== userId) {
          throw new Error("SCIM_EXTERNAL_ID_CONFLICT");
        }
        if (!existingMapping) {
          // Delete stale mapping for this user (handles externalId change: ext-A → ext-B)
          await tx.scimExternalMapping.deleteMany({
            where: {
              tenantId,
              internalId: userId,
              resourceType: "User",
            },
          });
          await tx.scimExternalMapping.create({
            data: { orgId, tenantId, externalId, resourceType: "User", internalId: userId },
          });
        }
      } else {
        // PUT is a full replace — no externalId means clear any existing mapping
        await tx.scimExternalMapping.deleteMany({
          where: {
            tenantId,
            internalId: userId,
            resourceType: "User",
          },
        });
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === "SCIM_EXTERNAL_ID_CONFLICT") {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    if (isScimExternalMappingUniqueViolation(e)) {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: auditAction,
    userId: auditUserId,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_MEMBER,
    targetId: userId,
    metadata: { active, externalId, name: name?.formatted },
    ...extractRequestMeta(req),
  });

  const baseUrl = getScimBaseUrl();
  const resource = await fetchUserResource(orgId, tenantId, userId, baseUrl);
  return scimResponse(resource!);
}

// PATCH /api/scim/v2/Users/[id] — Partial update
export async function PATCH(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { orgId, tenantId, auditUserId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const { id } = await params;
  const userId = await resolveUserId(orgId, tenantId, id);
  if (!userId) {
    return scimError(404, "User not found");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON");
  }

  const parsed = scimPatchOpSchema.safeParse(body);
  if (!parsed.success) {
    return scimError(400, parsed.error.issues.map((i) => i.message).join("; "));
  }

  let patchResult;
  try {
    patchResult = parseUserPatchOps(parsed.data.Operations);
  } catch (e) {
    if (e instanceof PatchParseError) {
      return scimError(400, e.message);
    }
    throw e;
  }

  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  if (!member) {
    return scimError(404, "User not found");
  }

  // OWNER protection
  if (member.role === ORG_ROLE.OWNER && patchResult.active === false) {
    return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
  }

  // Build update data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {};
  let auditAction: AuditAction = AUDIT_ACTION.SCIM_USER_UPDATE;

  if (patchResult.active !== undefined) {
    if (patchResult.active) {
      updateData.deactivatedAt = null;
      if (member.deactivatedAt !== null) {
        auditAction = AUDIT_ACTION.SCIM_USER_REACTIVATE;
      }
    } else {
      updateData.deactivatedAt = member.deactivatedAt ?? new Date();
      if (member.deactivatedAt === null) {
        auditAction = AUDIT_ACTION.SCIM_USER_DEACTIVATE;
      }
    }
  }

  // Always mark as SCIM-managed when touched via PATCH
  updateData.scimManaged = true;

  await prisma.orgMember.update({
    where: { id: member.id },
    data: updateData,
  });

  // Update User.name if requested (OrgMember attribute, not User table — per plan)
  // Note: name.formatted maps to User.name, but per plan we only update User table at first provision.
  // For PATCH, we skip User.name updates to avoid multi-org side effects.

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: auditAction,
    userId: auditUserId,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_MEMBER,
    targetId: userId,
    metadata: { active: patchResult.active, name: patchResult.name },
    ...extractRequestMeta(req),
  });

  const baseUrl = getScimBaseUrl();
  const resource = await fetchUserResource(orgId, tenantId, userId, baseUrl);
  return scimResponse(resource!);
}

// DELETE /api/scim/v2/Users/[id] — Hard delete OrgMember + OrgMemberKey + ScimExternalMapping
export async function DELETE(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { orgId, tenantId, auditUserId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const { id } = await params;
  const userId = await resolveUserId(orgId, tenantId, id);
  if (!userId) {
    return scimError(404, "User not found");
  }

  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: { user: { select: { email: true } } },
  });
  if (!member) {
    return scimError(404, "User not found");
  }

  // OWNER protection
  if (member.role === ORG_ROLE.OWNER) {
    return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
  }

  // Atomic delete: OrgMemberKey + ScimExternalMapping + OrgMember
  try {
    await prisma.$transaction([
      prisma.orgMemberKey.deleteMany({ where: { orgId, userId } }),
      prisma.scimExternalMapping.deleteMany({
        where: {
          tenantId,
          internalId: userId,
          resourceType: "User",
        },
      }),
      prisma.orgMember.delete({ where: { id: member.id } }),
    ]);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      return scimError(409, "Cannot delete user: related resources exist");
    }
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.SCIM_USER_DELETE,
    userId: auditUserId,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_MEMBER,
    targetId: userId,
    metadata: { email: member.user.email, role: member.role },
    ...extractRequestMeta(req),
  });

  return new Response(null, { status: 204 });
}
