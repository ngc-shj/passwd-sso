import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { checkAuth } from "@/lib/auth/check-auth";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { updateTeamE2EPasswordSchema } from "@/lib/validations";
import {
  requireTeamPermission,
  requireTeamMember,
  hasTeamPermission,
} from "@/lib/auth/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION, TEAM_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION, EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, forbidden, handleAuthError, notFound, unauthorized } from "@/lib/api-response";
import * as teamPasswordService from "@/lib/services/team-password-service";
import { TeamPasswordServiceError } from "@/lib/services/team-password-service";

type Params = { params: Promise<{ teamId: string; id: string }> };

// GET /api/teams/[teamId]/passwords/[id] — Get password detail (encrypted blob, client decrypts)
async function handleGET(req: NextRequest, { params }: Params) {
  const authed = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_READ });
  if (!authed.ok) return authed.response;
  const { userId } = authed.auth;

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.PASSWORD_READ, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const entry = await withTeamTenantRls(teamId, () =>
    teamPasswordService.getTeamPassword(teamId, id, userId),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  return NextResponse.json({
    id: entry.id,
    entryType: entry.entryType,
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    teamFolderId: entry.teamFolderId,
    tags: entry.tags,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    encryptedBlob: entry.encryptedBlob,
    blobIv: entry.blobIv,
    blobAuthTag: entry.blobAuthTag,
    encryptedOverview: entry.encryptedOverview,
    overviewIv: entry.overviewIv,
    overviewAuthTag: entry.overviewAuthTag,
    aadVersion: entry.aadVersion,
    teamKeyVersion: entry.teamKeyVersion,
    itemKeyVersion: entry.itemKeyVersion,
    ...(entry.itemKeyVersion >= 1 ? {
      encryptedItemKey: entry.encryptedItemKey,
      itemKeyIv: entry.itemKeyIv,
      itemKeyAuthTag: entry.itemKeyAuthTag,
    } : {}),
    requireReprompt: entry.requireReprompt,
    expiresAt: entry.expiresAt,
  });
}

// PUT /api/teams/[teamId]/passwords/[id] — Update password (E2E: full blob replacement)
async function handlePUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  let membership;
  try {
    membership = await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const existingEntry = await withTeamTenantRls(teamId, () =>
    teamPasswordService.getTeamPasswordForUpdate(teamId, id),
  );

  if (!existingEntry || existingEntry.teamId !== teamId) {
    return notFound();
  }

  // MEMBER can only update their own entries
  if (!hasTeamPermission(membership.role, TEAM_PERMISSION.PASSWORD_UPDATE)) {
    return forbidden();
  }
  if (
    membership.role === TEAM_ROLE.MEMBER &&
    existingEntry.createdById !== session.user.id
  ) {
    return errorResponse(API_ERROR.ONLY_OWN_ENTRIES, 403);
  }

  const result = await parseBody(req, updateTeamE2EPasswordSchema);
  if (!result.ok) return result.response;

  const { encryptedBlob, encryptedOverview, aadVersion, teamKeyVersion, itemKeyVersion, encryptedItemKey, tagIds, teamFolderId, isArchived, requireReprompt, expiresAt } = result.data;

  let updated;
  try {
    updated = await withTeamTenantRls(teamId, () =>
      teamPasswordService.updateTeamPassword(teamId, id, {
        encryptedBlob,
        encryptedOverview,
        aadVersion,
        teamKeyVersion,
        itemKeyVersion,
        encryptedItemKey,
        tagIds,
        teamFolderId,
        isArchived,
        requireReprompt,
        expiresAt,
        userId: session.user.id,
        existingEntry,
      }),
    );
  } catch (e) {
    if (e instanceof TeamPasswordServiceError) {
      return errorResponse(e.code, e.statusHint);
    }
    throw e;
  }

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.ENTRY_UPDATE,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
  });

  return NextResponse.json({
    id: updated.id,
    entryType: updated.entryType,
    tags: updated.tags,
    updatedAt: updated.updatedAt,
  });
}

// DELETE /api/teams/[teamId]/passwords/[id] — Soft delete (move to trash)
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const existing = await withTeamTenantRls(teamId, () =>
    teamPasswordService.getTeamPasswordForUpdate(teamId, id),
  );

  if (!existing || existing.teamId !== teamId) {
    return notFound();
  }

  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  await withTeamTenantRls(teamId, () =>
    teamPasswordService.deleteTeamPassword(teamId, id, permanent),
  );

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.ENTRY_DELETE,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    metadata: { permanent },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
