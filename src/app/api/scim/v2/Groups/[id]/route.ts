import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import { scimPatchOpSchema, scimGroupSchema } from "@/lib/scim/validations";
import { parseGroupPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { authorizeScim } from "@/lib/scim/with-scim-auth";
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
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.data;

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
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId, auditUserId, actorType: putActorType } = auth.data;

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

  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    userId: auditUserId,
    actorType: putActorType,
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

  return scimResponse(serviceResult.resource);
}

// PATCH /api/scim/v2/Groups/[id] — Add/remove members
async function handlePATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId, auditUserId, actorType: patchActorType } = auth.data;

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

  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    userId: auditUserId,
    actorType: patchActorType,
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

  return scimResponse(serviceResult.resource);
}

// DELETE /api/scim/v2/Groups/[id] — Not allowed
async function handleDELETE(req: NextRequest, { params }: Params): Promise<Response> {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;

  await params;

  return scimError(405, "Role-based groups cannot be deleted");
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const PATCH = withRequestLog(handlePATCH);
export const DELETE = withRequestLog(handleDELETE);
