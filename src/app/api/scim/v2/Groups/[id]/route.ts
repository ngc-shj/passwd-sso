import type { NextRequest } from "next/server";
import type { Prisma, ActorType, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isMembershipLockConflict, membershipConflictMessage } from "@/lib/team/tenant-row-lock";
import { TEAM_MEMBERSHIP_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { logAuditAsync, logAuditBulkInTx, tenantAuditBase, teamAuditBase } from "@/lib/audit/audit";
import { scimResponse, scimError, getScimBaseUrl } from "@/lib/scim/response";
import { scimPatchOpSchema, scimGroupSchema } from "@/lib/scim/validations";
import { parseGroupPatchOps, PatchParseError } from "@/lib/scim/patch-parser";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { scimParseBody } from "@/lib/scim/parse-body";
import { authorizeScim } from "@/lib/scim/with-scim-auth";
import {
  fetchScimGroup,
  replaceScimGroup,
  patchScimGroup,
  ScimGroupNotFoundError,
  ScimOwnerProtectedError,
  ScimNoSuchMemberError,
  ScimDisplayNameMismatchError,
  ScimMembershipChangedError,
  SCIM_TRANSITION_KIND,
  type ScimMemberTransition,
  type ScimTransitionKind,
} from "@/lib/services/scim-group-service";

type Params = { params: Promise<{ id: string }> };

// Every SCIM transition kind maps to exactly one TEAM-scope audit action
// (C4) — adding a kind to scim-group-service.ts without extending this map
// is a compile error.
const SCIM_TRANSITION_ACTION: Record<ScimTransitionKind, AuditAction> = {
  [SCIM_TRANSITION_KIND.BECAME_PENDING]: AUDIT_ACTION.TEAM_MEMBER_SCIM_PENDING,
  [SCIM_TRANSITION_KIND.PENDING_ROLE_RAISED]: AUDIT_ACTION.TEAM_MEMBER_SCIM_PENDING,
  [SCIM_TRANSITION_KIND.PENDING_WITHDRAWN]: AUDIT_ACTION.TEAM_MEMBER_SCIM_PENDING_WITHDRAW,
  [SCIM_TRANSITION_KIND.ACTIVE_REMOVED]: AUDIT_ACTION.TEAM_MEMBER_SCIM_REMOVE,
  [SCIM_TRANSITION_KIND.DEPARTED_UNMARKED]: AUDIT_ACTION.TEAM_MEMBER_SCIM_REMOVE,
  [SCIM_TRANSITION_KIND.ACTIVE_ROLE_CHANGED]: AUDIT_ACTION.TEAM_MEMBER_SCIM_ROLE_UPDATE,
};

function transitionsFor(transitions: ScimMemberTransition[], action: AuditAction): ScimMemberTransition[] {
  return transitions.filter((t) => SCIM_TRANSITION_ACTION[t.kind] === action);
}

/**
 * Write one TEAM-scope audit row per SCIM member transition (C4), inside the
 * same transaction as the writes that produced them — one `logAuditBulkInTx`
 * call per action present, so a 1000-user sync is a handful of round trips,
 * not one per row. Called by both PUT and PATCH with the `withTenantRls`
 * callback's own `tx`.
 */
async function emitScimTransitionAudits(
  tx: Prisma.TransactionClient,
  req: NextRequest,
  tenantId: string,
  teamId: string,
  auditUserId: string,
  actorType: ActorType,
  scimTokenId: string,
  transitions: ScimMemberTransition[],
): Promise<void> {
  if (transitions.length === 0) return;
  const base = { ...teamAuditBase(req, auditUserId, teamId), actorType };

  await logAuditBulkInTx(
    tx,
    tenantId,
    transitionsFor(transitions, AUDIT_ACTION.TEAM_MEMBER_SCIM_PENDING).map((t) => ({
      ...base,
      action: AUDIT_ACTION.TEAM_MEMBER_SCIM_PENDING,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: t.userId,
      metadata:
        t.previousRole != null
          ? { scimTokenId, role: t.role, previousRole: t.previousRole }
          : { scimTokenId, role: t.role },
    })),
  );

  await logAuditBulkInTx(
    tx,
    tenantId,
    transitionsFor(transitions, AUDIT_ACTION.TEAM_MEMBER_SCIM_PENDING_WITHDRAW).map((t) => ({
      ...base,
      action: AUDIT_ACTION.TEAM_MEMBER_SCIM_PENDING_WITHDRAW,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: t.userId,
      metadata: { scimTokenId, role: t.role },
    })),
  );

  await logAuditBulkInTx(
    tx,
    tenantId,
    transitionsFor(transitions, AUDIT_ACTION.TEAM_MEMBER_SCIM_REMOVE).map((t) => ({
      ...base,
      action: AUDIT_ACTION.TEAM_MEMBER_SCIM_REMOVE,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: t.userId,
      metadata:
        t.kind === SCIM_TRANSITION_KIND.DEPARTED_UNMARKED
          ? { scimTokenId, role: t.role, departed: true }
          : { scimTokenId, role: t.role },
    })),
  );

  await logAuditBulkInTx(
    tx,
    tenantId,
    transitionsFor(transitions, AUDIT_ACTION.TEAM_MEMBER_SCIM_ROLE_UPDATE).map((t) => ({
      ...base,
      action: AUDIT_ACTION.TEAM_MEMBER_SCIM_ROLE_UPDATE,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: t.userId,
      metadata: { scimTokenId, role: t.role, previousRole: t.previousRole },
    })),
  );
}

// GET /api/scim/v2/Groups/[id]
async function handleGET(req: NextRequest, { params }: Params) {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.data;

  const { id } = await params;

  return withTenantRls(prisma, tenantId, async (tx) => {
    const resource = await fetchScimGroup(tenantId, id, getScimBaseUrl(), tx);
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
  const { tenantId, auditUserId, actorType: putActorType, tokenId } = auth.data;

  const bodyResult = await scimParseBody(req, scimGroupSchema);
  if (!bodyResult.ok) return bodyResult.response;

  const { id } = await params;

  let serviceResult: Awaited<ReturnType<typeof replaceScimGroup>>;
  try {
    serviceResult = await withTenantRls(
      prisma,
      tenantId,
      async (tx) => {
        const result = await replaceScimGroup(tenantId, id, {
          displayName: bodyResult.data.displayName,
          memberUserIds: bodyResult.data.members.map((m) => m.value),
        }, getScimBaseUrl(), tx);
        await emitScimTransitionAudits(
          tx, req, tenantId, result.teamId, auditUserId, putActorType, tokenId, result.transitions,
        );
        return result;
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
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
      return scimError(400, "Referenced user is not an active member of this tenant");
    }
    // A pending row this PUT was about to withdraw vanished between the
    // locked re-read and its delete (only an unlocked writer can cause it —
    // see ScimMembershipChangedError). Rolled back; the IdP's retry will emit
    // exact transitions.
    if (e instanceof ScimMembershipChangedError) {
      return scimError(409, "A member's membership changed during the update; retry");
    }
    // A rotation of the team, or a change to an added user's tenant membership,
    // held a row past the lock wait (or the transaction deadlocked); nothing changed.
    if (isMembershipLockConflict(e)) return scimError(409, membershipConflictMessage(e));
    throw e;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auditUserId, tenantId),
    actorType: putActorType,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    teamId: serviceResult.teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: id,
    metadata: {
      role: serviceResult.role,
      added: serviceResult.added,
      removed: serviceResult.removed,
    },
  });

  return scimResponse(serviceResult.resource);
}

// PATCH /api/scim/v2/Groups/[id] — Add/remove members
async function handlePATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId, auditUserId, actorType: patchActorType, tokenId } = auth.data;

  const bodyResult = await scimParseBody(req, scimPatchOpSchema);
  if (!bodyResult.ok) return bodyResult.response;

  let actions;
  try {
    actions = parseGroupPatchOps(bodyResult.data.Operations);
  } catch (e) {
    if (e instanceof PatchParseError) {
      return scimError(400, e.message);
    }
    throw e;
  }

  const { id } = await params;

  let serviceResult: Awaited<ReturnType<typeof patchScimGroup>>;
  try {
    serviceResult = await withTenantRls(
      prisma,
      tenantId,
      async (tx) => {
        const result = await patchScimGroup(tenantId, id, actions, getScimBaseUrl(), tx);
        await emitScimTransitionAudits(
          tx, req, tenantId, result.teamId, auditUserId, patchActorType, tokenId, result.transitions,
        );
        return result;
      },
      { timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (e instanceof ScimGroupNotFoundError) {
      return scimError(404, "Group not found");
    }
    if (e instanceof ScimOwnerProtectedError) {
      return scimError(403, API_ERROR.SCIM_OWNER_PROTECTED);
    }
    if (e instanceof ScimNoSuchMemberError) {
      return scimError(400, "Referenced user is not an active member of this tenant");
    }
    // Same shortfall as PUT's arm above — see ScimMembershipChangedError.
    if (e instanceof ScimMembershipChangedError) {
      return scimError(409, "A member's membership changed during the update; retry");
    }
    // A rotation of the team, or a change to an added user's tenant membership,
    // held a row past the lock wait (or the transaction deadlocked); nothing changed.
    if (isMembershipLockConflict(e)) return scimError(409, membershipConflictMessage(e));
    throw e;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auditUserId, tenantId),
    actorType: patchActorType,
    action: AUDIT_ACTION.SCIM_GROUP_UPDATE,
    teamId: serviceResult.teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
    targetId: id,
    metadata: {
      role: serviceResult.role,
      operations: actions.map((a) => ({ op: a.op, userId: a.userId })),
    },
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
