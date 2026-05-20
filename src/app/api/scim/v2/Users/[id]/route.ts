import type { NextRequest } from "next/server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import { scimUserSchema, scimPatchOpSchema } from "@/lib/scim/validations";
import { parseUserPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import {
  invalidateUserSessions,
  type InvalidateUserSessionsResult,
} from "@/lib/auth/session/user-session-invalidation";
import { getLogger } from "@/lib/logger";
import { withRequestLog } from "@/lib/http/with-request-log";
import { scimParseBody } from "@/lib/scim/parse-body";
import { prisma } from "@/lib/prisma";
import { authorizeScim } from "@/lib/scim/with-scim-auth";
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
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.data;

  return withTenantRls(prisma, tenantId, async (tx) => {
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
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId, auditUserId, actorType: putActorType } = auth.data;

  const bodyResult = await scimParseBody(req, scimUserSchema);
  if (!bodyResult.ok) return bodyResult.response;
  const { active, externalId, name } = bodyResult.data;

  const { id } = await params;

  let serviceResult;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, (tx) =>
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
  let invalidationCounts: InvalidateUserSessionsResult | undefined;
  let sessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
    try {
      invalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      sessionInvalidationFailed = true;
      getLogger().error({ userId, error }, "session-invalidation-failed");
    }
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auditUserId, tenantId),
    actorType: putActorType,
    action: auditAction,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: userId,
    metadata: {
      active,
      externalId,
      name: name?.formatted,
      ...(invalidationCounts ?? {}),
      ...(sessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
  });

  return scimResponse(resource);
}

// PATCH /api/scim/v2/Users/[id] — Partial update
async function handlePATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId, auditUserId, actorType: patchActorType } = auth.data;

  const bodyResult = await scimParseBody(req, scimPatchOpSchema);
  if (!bodyResult.ok) return bodyResult.response;

  let patchOps;
  try {
    patchOps = parseUserPatchOps(bodyResult.data.Operations);
  } catch (e) {
    if (e instanceof PatchParseError) {
      return scimError(400, e.message);
    }
    throw e;
  }

  const { id } = await params;

  let serviceResult;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, (tx) =>
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
  let patchInvalidationCounts: InvalidateUserSessionsResult | undefined;
  let patchSessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
    try {
      patchInvalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      patchSessionInvalidationFailed = true;
      getLogger().error({ userId, error }, "session-invalidation-failed");
    }
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auditUserId, tenantId),
    actorType: patchActorType,
    action: auditAction,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: userId,
    metadata: {
      active: patchOps.active,
      name: patchOps.name,
      ...(patchInvalidationCounts ?? {}),
      ...(patchSessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
  });

  return scimResponse(resource);
}

// DELETE /api/scim/v2/Users/[id] — Remove from tenant
async function handleDELETE(req: NextRequest, { params }: Params): Promise<Response> {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId, auditUserId, actorType: deleteActorType } = auth.data;

  const { id } = await params;

  let serviceResult;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, (tx) =>
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
  let deleteInvalidationCounts: InvalidateUserSessionsResult | undefined;
  let deleteSessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
    try {
      deleteInvalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      deleteSessionInvalidationFailed = true;
      getLogger().error({ userId, error }, "session-invalidation-failed");
    }
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auditUserId, tenantId),
    actorType: deleteActorType,
    action: AUDIT_ACTION.SCIM_USER_DELETE,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: userId,
    metadata: {
      email: userEmail,
      ...(deleteInvalidationCounts ?? {}),
      ...(deleteSessionInvalidationFailed ? { sessionInvalidationFailed: true } : {}),
    },
  });

  return new Response(null, { status: 204 });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const PATCH = withRequestLog(handlePATCH);
export const DELETE = withRequestLog(handleDELETE);
