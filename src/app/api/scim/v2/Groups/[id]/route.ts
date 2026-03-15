import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateScimToken } from "@/lib/scim-token";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import { scimPatchOpSchema, scimGroupSchema } from "@/lib/scim/validations";
import { parseGroupPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { dispatchTenantWebhook } from "@/lib/webhook-dispatcher";
import { withTenantRls } from "@/lib/tenant-rls";
import { enforceAccessRestriction } from "@/lib/access-restriction";
import { withRequestLog } from "@/lib/with-request-log";
import {
  fetchScimGroup,
  replaceScimGroup,
  patchScimGroup,
  ScimGroupNotFoundError,
  ScimOwnerProtectedError,
  ScimNoSuchMemberError,
  ScimDisplayNameMismatchError,
} from "@/lib/services/scim-group-service";

type Params = { params: Promise<{ id: string }> };

// GET /api/scim/v2/Groups/[id]
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

  const { id } = await params;

  return withTenantRls(prisma, tenantId, async () => {
    const resource = await fetchScimGroup(tenantId, id, getScimBaseUrl());
    if (!resource) {
      return scimError(404, "Group not found");
    }
    return scimResponse(resource);
  });
}

// PUT /api/scim/v2/Groups/[id] — Full member replacement
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

  const parsed = scimGroupSchema.safeParse(body);
  if (!parsed.success) {
    return scimError(400, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { id } = await params;

  let serviceResult: Awaited<ReturnType<typeof replaceScimGroup>>;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, () =>
      replaceScimGroup(tenantId, id, {
        displayName: parsed.data.displayName,
        memberUserIds: parsed.data.members.map((m) => m.value),
      }, getScimBaseUrl()),
    );
  } catch (e) {
    if (e instanceof ScimGroupNotFoundError) {
      return scimError(404, "Group not found");
    }
    if (e instanceof ScimDisplayNameMismatchError) {
      return scimError(400, e.message);
    }
    if (e instanceof ScimOwnerProtectedError) {
      return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    }
    if (e instanceof ScimNoSuchMemberError) {
      return scimError(400, "Referenced member does not exist in this team");
    }
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    userId: auditUserId,
    teamId: serviceResult.teamId,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: id,
    metadata: {
      role: serviceResult.role,
      added: serviceResult.added,
      removed: serviceResult.removed,
    },
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    tenantId,
    timestamp: new Date().toISOString(),
    data: { groupId: id, teamId: serviceResult.teamId },
  });

  return scimResponse(serviceResult.resource);
}

// PATCH /api/scim/v2/Groups/[id] — Add/remove members
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

  let actions;
  try {
    actions = parseGroupPatchOps(parsed.data.Operations);
  } catch (e) {
    if (e instanceof PatchParseError) {
      return scimError(400, e.message);
    }
    throw e;
  }

  const { id } = await params;

  let serviceResult: Awaited<ReturnType<typeof patchScimGroup>>;
  try {
    serviceResult = await withTenantRls(prisma, tenantId, () =>
      patchScimGroup(tenantId, id, actions, getScimBaseUrl()),
    );
  } catch (e) {
    if (e instanceof ScimGroupNotFoundError) {
      return scimError(404, "Group not found");
    }
    if (e instanceof ScimOwnerProtectedError) {
      return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    }
    if (e instanceof ScimNoSuchMemberError) {
      return scimError(400, "Referenced member does not exist in this team");
    }
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    userId: auditUserId,
    teamId: serviceResult.teamId,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: id,
    metadata: {
      role: serviceResult.role,
      operations: actions.map((a) => ({ op: a.op, userId: a.userId })),
    },
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    tenantId,
    timestamp: new Date().toISOString(),
    data: { groupId: id, teamId: serviceResult.teamId },
  });

  return scimResponse(serviceResult.resource);
}

// DELETE /api/scim/v2/Groups/[id] — Not allowed
async function handleDELETE(req: NextRequest, { params }: Params): Promise<Response> {
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

  await params;

  return scimError(405, "Role-based groups cannot be deleted");
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const PATCH = withRequestLog(handlePATCH);
export const DELETE = withRequestLog(handleDELETE);
