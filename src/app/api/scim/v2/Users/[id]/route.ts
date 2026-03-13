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
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";
import { withTenantRls } from "@/lib/tenant-rls";
import { enforceAccessRestriction } from "@/lib/access-restriction";
import { invalidateUserSessions } from "@/lib/user-session-invalidation";
import { getLogger } from "@/lib/logger";
import { withRequestLog } from "@/lib/with-request-log";

type Params = { params: Promise<{ id: string }> };

async function resolveUserId(tenantId: string, scimId: string): Promise<string | null> {
  if (scimId.length > 255) return null;

  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId: scimId } },
    select: { userId: true },
  });
  if (member) return member.userId;

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

async function fetchUserResource(tenantId: string, userId: string, baseUrl: string) {
  const member = await prisma.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!member || !member.user?.email) return null;

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
async function handleGET(req: NextRequest, { params }: Params) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { tenantId } = result.data;

  const denied = await enforceAccessRestriction(req, "scim", tenantId);
  if (denied) return denied;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  return withTenantRls(prisma, tenantId, async () => {
    const { id } = await params;
    const userId = await resolveUserId(tenantId, id);
    if (!userId) {
      return scimError(404, "User not found");
    }

    const resource = await fetchUserResource(tenantId, userId, getScimBaseUrl());
    if (!resource) {
      return scimError(404, "User not found");
    }

    return scimResponse(resource);
  });
}

// PUT /api/scim/v2/Users/[id] — Full replace
async function handlePUT(req: NextRequest, { params }: Params): Promise<Response> {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { tenantId, auditUserId } = result.data;

  const denied = await enforceAccessRestriction(req, "scim", tenantId);
  if (denied) return denied;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
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

  const { id } = await params;
  const resultResponse = await withTenantRls(prisma, tenantId, async () => {
    const userId = await resolveUserId(tenantId, id);
    if (!userId) {
      return { error: scimError(404, "User not found") };
    }

    const member = await prisma.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { id: true, role: true, deactivatedAt: true },
    });
    if (!member) {
      return { error: scimError(404, "User not found") };
    }
    if (member.role === "OWNER" && active === false) {
      return { error: scimError(403, API_ERROR.SCIM_OWNER_PROTECTED) };
    }

    let auditAction: AuditAction = AUDIT_ACTION.SCIM_USER_UPDATE;
    if (active === false && member.deactivatedAt === null) {
      auditAction = AUDIT_ACTION.SCIM_USER_DEACTIVATE;
    } else if (active !== false && member.deactivatedAt !== null) {
      auditAction = AUDIT_ACTION.SCIM_USER_REACTIVATE;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.tenantMember.update({
          where: { id: member.id },
          data: {
            deactivatedAt: active === false ? (member.deactivatedAt ?? new Date()) : null,
            scimManaged: true,
            provisioningSource: "SCIM",
            lastScimSyncedAt: new Date(),
          },
        });

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
            await tx.scimExternalMapping.deleteMany({
              where: {
                tenantId,
                internalId: userId,
                resourceType: "User",
              },
            });
            await tx.scimExternalMapping.create({
              data: { tenantId, externalId, resourceType: "User", internalId: userId },
            });
          }
        } else {
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
        return { error: scimError(409, "externalId is already mapped to a different resource", "uniqueness") };
      }
      if (isScimExternalMappingUniqueViolation(e)) {
        return { error: scimError(409, "externalId is already mapped to a different resource", "uniqueness") };
      }
      throw e;
    }

    const resource = await fetchUserResource(tenantId, userId, getScimBaseUrl());
    return { resource, userId, auditAction };
  });
  if ("error" in resultResponse) {
    return resultResponse.error as Response;
  }
  const { resource, userId, auditAction } = resultResponse as Exclude<typeof resultResponse, { error: unknown }>;

  // Session invalidation on deactivation (fail-open)
  let invalidationCounts: { sessions: number; extensionTokens: number; apiKeys: number } | undefined;
  let sessionInvalidationFailed = false;
  if (auditAction === AUDIT_ACTION.SCIM_USER_DEACTIVATE) {
    try {
      invalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      sessionInvalidationFailed = true;
      getLogger().error({ userId, error }, "session-invalidation-failed");
    }
  }

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: auditAction,
    userId: auditUserId,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: userId,
    metadata: {
      active,
      externalId,
      name: name?.formatted,
      ...(invalidationCounts ?? {}),
      ...(sessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
    ...extractRequestMeta(req),
  });

  return scimResponse(resource!);
}

// PATCH /api/scim/v2/Users/[id] — Partial update
async function handlePATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { tenantId, auditUserId } = result.data;

  const denied = await enforceAccessRestriction(req, "scim", tenantId);
  if (denied) return denied;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
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

  const { id } = await params;
  const resultResponse = await withTenantRls(prisma, tenantId, async () => {
    const userId = await resolveUserId(tenantId, id);
    if (!userId) {
      return { error: scimError(404, "User not found") };
    }

    const member = await prisma.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    if (!member) {
      return { error: scimError(404, "User not found") };
    }

    if (member.role === "OWNER" && patchResult.active === false) {
      return { error: scimError(403, API_ERROR.SCIM_OWNER_PROTECTED) };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = {
      scimManaged: true,
      provisioningSource: "SCIM",
      lastScimSyncedAt: new Date(),
    };

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

    await prisma.tenantMember.update({
      where: { id: member.id },
      data: updateData,
    });

    const resource = await fetchUserResource(tenantId, userId, getScimBaseUrl());
    return { resource, userId, auditAction };
  });
  if ("error" in resultResponse) {
    return resultResponse.error as Response;
  }
  const { resource, userId, auditAction } = resultResponse as Exclude<typeof resultResponse, { error: unknown }>;

  // Session invalidation on deactivation (fail-open)
  let patchInvalidationCounts: { sessions: number; extensionTokens: number; apiKeys: number } | undefined;
  let patchSessionInvalidationFailed = false;
  if (auditAction === AUDIT_ACTION.SCIM_USER_DEACTIVATE) {
    try {
      patchInvalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      patchSessionInvalidationFailed = true;
      getLogger().error({ userId, error }, "session-invalidation-failed");
    }
  }

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: auditAction,
    userId: auditUserId,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: userId,
    metadata: {
      active: patchResult.active,
      name: patchResult.name,
      ...(patchInvalidationCounts ?? {}),
      ...(patchSessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
    ...extractRequestMeta(req),
  });

  return scimResponse(resource!);
}

// DELETE /api/scim/v2/Users/[id] — Remove from tenant
async function handleDELETE(req: NextRequest, { params }: Params): Promise<Response> {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { tenantId, auditUserId } = result.data;

  const denied = await enforceAccessRestriction(req, "scim", tenantId);
  if (denied) return denied;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const { id } = await params;
  const resultResponse = await withTenantRls(prisma, tenantId, async () => {
    const userId = await resolveUserId(tenantId, id);
    if (!userId) {
      return { error: scimError(404, "User not found") };
    }

    const member = await prisma.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: { user: { select: { email: true } } },
    });
    if (!member) {
      return { error: scimError(404, "User not found") };
    }

    if (member.role === "OWNER") {
      return { error: scimError(403, API_ERROR.SCIM_OWNER_PROTECTED) };
    }

    try {
      await prisma.$transaction([
        prisma.teamMemberKey.deleteMany({ where: { tenantId, userId } }),
        prisma.scimExternalMapping.deleteMany({
          where: {
            tenantId,
            internalId: userId,
            resourceType: "User",
          },
        }),
        prisma.teamMember.deleteMany({ where: { tenantId, userId } }),
        prisma.tenantMember.delete({
          where: {
            tenantId_userId: {
              tenantId,
              userId,
            },
          },
        }),
      ]);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
        return { error: scimError(409, "Cannot delete user: related resources exist") };
      }
      throw e;
    }

    return { userId, member };
  });
  if ("error" in resultResponse) {
    return resultResponse.error as Response;
  }
  const { userId, member } = resultResponse as Exclude<typeof resultResponse, { error: unknown }>;

  // Session invalidation after deletion (fail-open)
  let deleteInvalidationCounts: { sessions: number; extensionTokens: number; apiKeys: number } | undefined;
  let deleteSessionInvalidationFailed = false;
  try {
    deleteInvalidationCounts = await invalidateUserSessions(userId, { tenantId });
  } catch (error) {
    deleteSessionInvalidationFailed = true;
    getLogger().error({ userId, error }, "session-invalidation-failed");
  }

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SCIM_USER_DELETE,
    userId: auditUserId,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: userId,
    metadata: {
      email: member.user?.email ?? null,
      ...(deleteInvalidationCounts ?? {}),
      ...(deleteSessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
    ...extractRequestMeta(req),
  });

  return new Response(null, { status: 204 });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const PATCH = withRequestLog(handlePATCH);
export const DELETE = withRequestLog(handleDELETE);
