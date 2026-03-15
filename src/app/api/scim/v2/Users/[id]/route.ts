import type { NextRequest } from "next/server";
import { validateScimToken } from "@/lib/scim-token";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import { scimUserSchema, scimPatchOpSchema } from "@/lib/scim/validations";
import { parseUserPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { dispatchTenantWebhook } from "@/lib/webhook-dispatcher";
import { withTenantRls } from "@/lib/tenant-rls";
import { enforceAccessRestriction } from "@/lib/access-restriction";
import { invalidateUserSessions } from "@/lib/user-session-invalidation";
import { getLogger } from "@/lib/logger";
import { withRequestLog } from "@/lib/with-request-log";
import { prisma } from "@/lib/prisma";
import {
  resolveUserId,
  fetchScimUser,
  replaceScimUser,
  patchScimUser,
  deactivateScimUser,
  ScimUserNotFoundError,
  ScimOwnerProtectedError,
  ScimExternalIdConflictError,
  ScimDeleteConflictError,
} from "@/lib/services/scim-user-service";

type Params = { params: Promise<{ id: string }> };

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

    const resource = await fetchScimUser(tenantId, userId, getScimBaseUrl());
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

  let serviceResult;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, () =>
      resolveUserId(tenantId, id).then((userId) => {
        if (!userId) throw new ScimUserNotFoundError();
        return replaceScimUser(tenantId, userId, { active, externalId, name }, getScimBaseUrl());
      }),
    );
  } catch (e) {
    if (e instanceof ScimUserNotFoundError) return scimError(404, "User not found");
    if (e instanceof ScimOwnerProtectedError) return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    if (e instanceof ScimExternalIdConflictError) {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    throw e;
  }

  const { resource, userId, auditAction, needsSessionInvalidation } = serviceResult;

  // Session invalidation on deactivation (fail-open)
  let invalidationCounts: { sessions: number; extensionTokens: number; apiKeys: number } | undefined;
  let sessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
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
  void dispatchTenantWebhook({
    type: auditAction,
    tenantId,
    timestamp: new Date().toISOString(),
    data: { userId },
  });

  return scimResponse(resource);
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

  let patchOps;
  try {
    patchOps = parseUserPatchOps(parsed.data.Operations);
  } catch (e) {
    if (e instanceof PatchParseError) {
      return scimError(400, e.message);
    }
    throw e;
  }

  const { id } = await params;

  let serviceResult;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, () =>
      resolveUserId(tenantId, id).then((userId) => {
        if (!userId) throw new ScimUserNotFoundError();
        return patchScimUser(tenantId, userId, patchOps, getScimBaseUrl());
      }),
    );
  } catch (e) {
    if (e instanceof ScimUserNotFoundError) return scimError(404, "User not found");
    if (e instanceof ScimOwnerProtectedError) return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    throw e;
  }

  const { resource, userId, auditAction, needsSessionInvalidation } = serviceResult;

  // Session invalidation on deactivation (fail-open)
  let patchInvalidationCounts: { sessions: number; extensionTokens: number; apiKeys: number } | undefined;
  let patchSessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
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
      active: patchOps.active,
      name: patchOps.name,
      ...(patchInvalidationCounts ?? {}),
      ...(patchSessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: auditAction,
    tenantId,
    timestamp: new Date().toISOString(),
    data: { userId },
  });

  return scimResponse(resource);
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

  let serviceResult;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, () =>
      resolveUserId(tenantId, id).then((userId) => {
        if (!userId) throw new ScimUserNotFoundError();
        return deactivateScimUser(tenantId, userId);
      }),
    );
  } catch (e) {
    if (e instanceof ScimUserNotFoundError) return scimError(404, "User not found");
    if (e instanceof ScimOwnerProtectedError) return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    if (e instanceof ScimDeleteConflictError) {
      return scimError(409, "Cannot delete user: related resources exist");
    }
    throw e;
  }

  const { userId, userEmail, needsSessionInvalidation } = serviceResult;

  // Session invalidation after deletion (fail-open)
  let deleteInvalidationCounts: { sessions: number; extensionTokens: number; apiKeys: number } | undefined;
  let deleteSessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
    try {
      deleteInvalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      deleteSessionInvalidationFailed = true;
      getLogger().error({ userId, error }, "session-invalidation-failed");
    }
  }

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SCIM_USER_DELETE,
    userId: auditUserId,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: userId,
    metadata: {
      email: userEmail,
      ...(deleteInvalidationCounts ?? {}),
      ...(deleteSessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.SCIM_USER_DELETE,
    tenantId,
    timestamp: new Date().toISOString(),
    data: { userId },
  });

  return new Response(null, { status: 204 });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const PATCH = withRequestLog(handlePATCH);
export const DELETE = withRequestLog(handleDELETE);
