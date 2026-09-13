import type { NextRequest } from "next/server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import { scimUserSchema, scimPatchOpSchema } from "@/lib/scim/validations";
import { parseUserPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { usersOwnedByAnotherTenant, wouldCreateSecondActiveMembership } from "@/lib/tenant-context";
import { isUniqueViolationOn, ONE_ACTIVE_MEMBERSHIP_INDEX } from "@/lib/prisma/prisma-error";
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
  loadScimUserSnapshot,
  toScimUserResource,
  replaceScimUser,
  patchScimUser,
  deactivateScimUser,
  SCIM_USER_NOT_PROVISIONABLE_DETAIL,
  ScimUserNotFoundError,
  ScimOwnerProtectedError,
  ScimExternalIdConflictError,
  ScimDeleteConflictError,
} from "@/lib/services/scim-user-service";
import { errorLogFields } from "@/lib/logger/error-fields";
import { fetchUserContact } from "@/lib/audit/audit-user-lookup";
import { REALIGNMENT_SOURCE, realignAfterActivation, type RealignmentCause } from "@/lib/tenant/tenant-realignment";

type Params = { params: Promise<{ id: string }> };

/**
 * Move a reactivated member's owning column after the tenant context commits: the
 * member may have been filed under another tenant while deactivated here, and this
 * tenant's context cannot write that users row. Logged on failure rather than
 * answered as a failed request whose reactivation already committed.
 */
async function realignReactivatedMember(
  userId: string,
  tenantId: string,
  actor: Pick<RealignmentCause, "actorUserId" | "actorType">,
): Promise<void> {
  try {
    await realignAfterActivation(userId, tenantId, { source: REALIGNMENT_SOURCE.SCIM, ...actor });
  } catch (error) {
    getLogger().error({ tenantId, userId, error: errorLogFields(error) }, "scim.realign-failed");
  }
}

/**
 * The response refusing a SCIM token's reactivation of this member, or null when
 * it may proceed. Two questions, in this order: would it make a second active
 * membership (uniqueness), and does this tenant own the user at all (authority).
 * A membership row here answers neither — see `usersOwnedByAnotherTenant`.
 */
async function reactivationRefusal(userId: string, tenantId: string): Promise<Response | null> {
  if (await wouldCreateSecondActiveMembership(userId, tenantId)) {
    return scimError(409, "User already belongs to another organization", "uniqueness");
  }
  if ((await usersOwnedByAnotherTenant(tenantId, [userId])).has(userId)) {
    return scimError(409, SCIM_USER_NOT_PROVISIONABLE_DETAIL, "uniqueness");
  }
  return null;
}

// GET /api/scim/v2/Users/[id]
async function handleGET(req: NextRequest, { params }: Params) {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.data;

  const { id } = await params;
  const snapshot = await withTenantRls(prisma, tenantId, async (tx) => {
    const userId = await resolveUserId(tenantId, id, tx);
    return userId ? loadScimUserSnapshot(tenantId, userId) : null;
  });
  // Identity is read after the tenant context closes; see loadScimUserSnapshot.
  const resource = snapshot ? await toScimUserResource(snapshot, getScimBaseUrl()) : null;
  if (!resource) {
    return scimError(404, "User not found");
  }

  return scimResponse(resource);
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

  // The reactivation guard the create path has and these arms did not. It must
  // run BETWEEN two tenant contexts, not inside one: the foreign membership row
  // is what RLS hides inside a tenant context, and opening a bypass inside one is
  // refused by the nesting guard. Sequential contexts are allowed; nested are not.
  // The id is resolved inside the guard's OWN bypass, not in a tenant context:
  // `resolveUserId` is explicitly tenant-scoped by argument, so it is safe there,
  // and this keeps the guard's reads off the mutation path entirely. The mutation
  // callback below resolves it again through its own `tx`, which is what keeps
  // that callback in the `(tx) =>` form `check-bypass-rls` requires.
  const resolvedUserId = await withBypassRls(
    prisma,
    (tx) => resolveUserId(tenantId, id, tx),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );
  if (!resolvedUserId) return scimError(404, "User not found");
  if (active !== false) {
    const refusal = await reactivationRefusal(resolvedUserId, tenantId);
    if (refusal) return refusal;
  }

  let serviceResult;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, (tx) =>
      resolveUserId(tenantId, id, tx).then((userId) => {
        if (!userId) throw new ScimUserNotFoundError();
        return replaceScimUser(tenantId, userId, { active, externalId, name });
      }),
    );
  } catch (e) {
    // The one-active-membership index, reached only on the race the guard above
    // cannot close: it runs in its own context a round trip earlier, and another
    // tenant can activate in between. Mapped to the same 409 the guard returns,
    // with its own message so the two are distinguishable in the log.
    if (isUniqueViolationOn(e, ONE_ACTIVE_MEMBERSHIP_INDEX)) {
      return scimError(409, "User already belongs to another organization", "uniqueness");
    }
    if (e instanceof ScimUserNotFoundError) return scimError(404, "User not found");
    if (e instanceof ScimOwnerProtectedError) return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    if (e instanceof ScimExternalIdConflictError) {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    throw e;
  }

  const { snapshot, userId, auditAction, needsSessionInvalidation } = serviceResult;
  if (auditAction === AUDIT_ACTION.SCIM_USER_REACTIVATE) {
    await realignReactivatedMember(userId, tenantId, { actorUserId: auditUserId, actorType: putActorType });
  }

  // Session invalidation on deactivation (fail-open)
  let invalidationCounts: InvalidateUserSessionsResult | undefined;
  let sessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
    try {
      invalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      sessionInvalidationFailed = true;
      getLogger().error({ userId, error: errorLogFields(error) }, "session-invalidation-failed");
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

  const resource = await toScimUserResource(snapshot, getScimBaseUrl());
  if (!resource) return scimError(404, "User not found");
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

  // The reactivation guard the create path has and these arms did not. It must
  // run BETWEEN two tenant contexts, not inside one: the foreign membership row
  // is what RLS hides inside a tenant context, and opening a bypass inside one is
  // refused by the nesting guard. Sequential contexts are allowed; nested are not.
  // The id is resolved inside the guard's OWN bypass, not in a tenant context:
  // `resolveUserId` is explicitly tenant-scoped by argument, so it is safe there,
  // and this keeps the guard's reads off the mutation path entirely. The mutation
  // callback below resolves it again through its own `tx`, which is what keeps
  // that callback in the `(tx) =>` form `check-bypass-rls` requires.
  const resolvedUserId = await withBypassRls(
    prisma,
    (tx) => resolveUserId(tenantId, id, tx),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );
  if (!resolvedUserId) return scimError(404, "User not found");
  // `=== true`, not `!== false`, because PATCH and PUT reach the transition
  // differently: `patchScimUser` touches `deactivatedAt` only when
  // `operations.active !== undefined`, so a name-only PATCH cannot reactivate
  // and must not be refused. PUT's schema defaults `active` to true and
  // `replaceScimUser` writes unconditionally, so `!== false` is right there.
  if (patchOps.active === true) {
    const refusal = await reactivationRefusal(resolvedUserId, tenantId);
    if (refusal) return refusal;
  }

  let serviceResult;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, (tx) =>
      resolveUserId(tenantId, id, tx).then((userId) => {
        if (!userId) throw new ScimUserNotFoundError();
        return patchScimUser(tenantId, userId, patchOps);
      }),
    );
  } catch (e) {
    // The one-active-membership index, reached only on the race the guard above
    // cannot close: it runs in its own context a round trip earlier, and another
    // tenant can activate in between. Mapped to the same 409 the guard returns,
    // with its own message so the two are distinguishable in the log.
    if (isUniqueViolationOn(e, ONE_ACTIVE_MEMBERSHIP_INDEX)) {
      return scimError(409, "User already belongs to another organization", "uniqueness");
    }
    if (e instanceof ScimUserNotFoundError) return scimError(404, "User not found");
    if (e instanceof ScimOwnerProtectedError) return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    throw e;
  }

  const { snapshot, userId, auditAction, needsSessionInvalidation } = serviceResult;
  if (auditAction === AUDIT_ACTION.SCIM_USER_REACTIVATE) {
    await realignReactivatedMember(userId, tenantId, { actorUserId: auditUserId, actorType: patchActorType });
  }

  // Session invalidation on deactivation (fail-open)
  let patchInvalidationCounts: InvalidateUserSessionsResult | undefined;
  let patchSessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
    try {
      patchInvalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      patchSessionInvalidationFailed = true;
      getLogger().error({ userId, error: errorLogFields(error) }, "session-invalidation-failed");
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

  const resource = await toScimUserResource(snapshot, getScimBaseUrl());
  if (!resource) return scimError(404, "User not found");
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
      resolveUserId(tenantId, id, tx).then((userId) => {
        if (!userId) throw new ScimUserNotFoundError();
        return deactivateScimUser(tenantId, userId);
      }),
    );
  } catch (e) {
    // The one-active-membership index, reached only on the race the guard above
    // cannot close: it runs in its own context a round trip earlier, and another
    // tenant can activate in between. Mapped to the same 409 the guard returns,
    // with its own message so the two are distinguishable in the log.
    if (isUniqueViolationOn(e, ONE_ACTIVE_MEMBERSHIP_INDEX)) {
      return scimError(409, "User already belongs to another organization", "uniqueness");
    }
    if (e instanceof ScimUserNotFoundError) return scimError(404, "User not found");
    if (e instanceof ScimOwnerProtectedError) return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    if (e instanceof ScimDeleteConflictError) {
      return scimError(409, "Cannot delete user: related resources exist");
    }
    throw e;
  }

  const { userId, needsSessionInvalidation } = serviceResult;

  // Session invalidation after deletion (fail-open)
  let deleteInvalidationCounts: InvalidateUserSessionsResult | undefined;
  let deleteSessionInvalidationFailed = false;
  if (needsSessionInvalidation) {
    try {
      deleteInvalidationCounts = await invalidateUserSessions(userId, { tenantId });
    } catch (error) {
      deleteSessionInvalidationFailed = true;
      getLogger().error({ userId, error: errorLogFields(error) }, "session-invalidation-failed");
    }
  }

  // Read after the tenant context closes: the membership read inside it can no
  // longer reach the email of a member whose users row names another tenant. A
  // failure costs the email, not the audit row: the deletion has already committed,
  // and answering it with a 500 left SCIM_USER_DELETE unwritten (round-5 F2).
  let contact: Awaited<ReturnType<typeof fetchUserContact>> = null;
  try {
    contact = await fetchUserContact(userId, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  } catch (error) {
    getLogger().error({ tenantId, userId, error: errorLogFields(error) }, "scim.delete-contact-read-failed");
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auditUserId, tenantId),
    actorType: deleteActorType,
    action: AUDIT_ACTION.SCIM_USER_DELETE,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: userId,
    metadata: {
      email: contact?.email ?? null,
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
