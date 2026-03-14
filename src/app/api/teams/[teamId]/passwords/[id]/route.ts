import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { authOrToken } from "@/lib/auth-or-token";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateTeamE2EPasswordSchema } from "@/lib/validations";
import {
  requireTeamPermission,
  requireTeamMember,
  hasTeamPermission,
  TeamAuthError,
} from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION, TEAM_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE, EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { dispatchWebhook } from "@/lib/webhook-dispatcher";
import { withRequestLog } from "@/lib/with-request-log";

type Params = { params: Promise<{ teamId: string; id: string }> };

// GET /api/teams/[teamId]/passwords/[id] — Get password detail (encrypted blob, client decrypts)
async function handleGET(req: NextRequest, { params }: Params) {
  const authResult = await authOrToken(req, EXTENSION_TOKEN_SCOPE.PASSWORDS_READ);
  if (!authResult || authResult.type === "scope_insufficient") {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  const userId = authResult.userId;

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      include: {
        tags: { select: { id: true, name: true, color: true } },
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        updatedBy: { select: { id: true, name: true, email: true } },
        favorites: {
          where: { userId },
          select: { id: true },
        },
      },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
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
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  let membership;
  try {
    membership = await requireTeamMember(session.user.id, teamId);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: {
        teamId: true,
        tenantId: true,
        createdById: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        aadVersion: true,
        teamKeyVersion: true,
        itemKeyVersion: true,
        encryptedItemKey: true,
        itemKeyIv: true,
        itemKeyAuthTag: true,
      },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // MEMBER can only update their own entries
  if (!hasTeamPermission(membership.role, TEAM_PERMISSION.PASSWORD_UPDATE)) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }
  if (
    membership.role === TEAM_ROLE.MEMBER &&
    entry.createdById !== session.user.id
  ) {
    return NextResponse.json(
      { error: API_ERROR.ONLY_OWN_ENTRIES },
      { status: 403 }
    );
  }

  const result = await parseBody(req, updateTeamE2EPasswordSchema);
  if (!result.ok) return result.response;

  const { encryptedBlob, encryptedOverview, aadVersion, teamKeyVersion, itemKeyVersion, encryptedItemKey, tagIds, teamFolderId, isArchived, requireReprompt, expiresAt } = result.data;
  const isFullUpdate = encryptedBlob !== undefined;

  // Prevent itemKeyVersion downgrade (v1→v0) — cryptographic downgrade attack
  if (itemKeyVersion !== undefined && itemKeyVersion < (entry.itemKeyVersion ?? 0)) {
    return NextResponse.json(
      { error: API_ERROR.ITEM_KEY_VERSION_DOWNGRADE },
      { status: 400 }
    );
  }

  // Upgrading v0→v>=1 requires encryptedItemKey; reusing v>=1 does not
  const existingVersion = entry.itemKeyVersion ?? 0;
  if (itemKeyVersion !== undefined && itemKeyVersion >= 1 && existingVersion < 1 && !encryptedItemKey) {
    return NextResponse.json(
      { error: API_ERROR.ITEM_KEY_REQUIRED },
      { status: 400 }
    );
  }

  // Validate teamKeyVersion matches current team key version (F-13)
  if (isFullUpdate) {
    const team = await withTeamTenantRls(teamId, async () =>
      prisma.team.findUnique({
        where: { id: teamId },
        select: { teamKeyVersion: true },
      }),
    );
    if (!team || teamKeyVersion !== team.teamKeyVersion) {
      return NextResponse.json(
        { error: API_ERROR.TEAM_KEY_VERSION_MISMATCH },
        { status: 409 }
      );
    }
  }

  // Validate teamFolderId belongs to this team
  if (teamFolderId) {
    const folder = await withTeamTenantRls(teamId, async () =>
      prisma.teamFolder.findUnique({
        where: { id: teamFolderId },
        select: { teamId: true },
      }),
    );
    if (!folder || folder.teamId !== teamId) {
      return NextResponse.json({ error: API_ERROR.FOLDER_NOT_FOUND }, { status: 400 });
    }
  }

  const updateData: Record<string, unknown> = {
    updatedById: session.user.id,
  };

  if (isFullUpdate) {
    updateData.encryptedBlob = encryptedBlob!.ciphertext;
    updateData.blobIv = encryptedBlob!.iv;
    updateData.blobAuthTag = encryptedBlob!.authTag;
    updateData.encryptedOverview = encryptedOverview!.ciphertext;
    updateData.overviewIv = encryptedOverview!.iv;
    updateData.overviewAuthTag = encryptedOverview!.authTag;
    updateData.aadVersion = aadVersion;
    updateData.teamKeyVersion = teamKeyVersion;
    if (itemKeyVersion !== undefined) {
      updateData.itemKeyVersion = itemKeyVersion;
      if (encryptedItemKey) {
        updateData.encryptedItemKey = encryptedItemKey.ciphertext;
        updateData.itemKeyIv = encryptedItemKey.iv;
        updateData.itemKeyAuthTag = encryptedItemKey.authTag;
      }
    }
  }

  if (teamFolderId !== undefined) updateData.teamFolderId = teamFolderId;
  if (isArchived !== undefined) updateData.isArchived = isArchived;
  if (requireReprompt !== undefined) updateData.requireReprompt = requireReprompt;
  if (expiresAt !== undefined) updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
  if (tagIds !== undefined) {
    updateData.tags = { set: tagIds.map((tid) => ({ id: tid })) };
  }

  // Snapshot + update in a single transaction for atomicity (F-9)
  const updated = await withTeamTenantRls(teamId, async () =>
    prisma.$transaction(async (tx) => {
      if (isFullUpdate) {
        await tx.teamPasswordEntryHistory.create({
          data: {
            entryId: id,
            tenantId: entry.tenantId,
            encryptedBlob: entry.encryptedBlob,
            blobIv: entry.blobIv,
            blobAuthTag: entry.blobAuthTag,
            aadVersion: entry.aadVersion,
            teamKeyVersion: entry.teamKeyVersion,
            itemKeyVersion: entry.itemKeyVersion,
            encryptedItemKey: entry.encryptedItemKey,
            itemKeyIv: entry.itemKeyIv,
            itemKeyAuthTag: entry.itemKeyAuthTag,
            changedById: session.user.id,
          },
        });
        const all = await tx.teamPasswordEntryHistory.findMany({
          where: { entryId: id },
          orderBy: [{ changedAt: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (all.length > 20) {
          await tx.teamPasswordEntryHistory.deleteMany({
            where: { id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
          });
        }
      }

      return tx.teamPasswordEntry.update({
        where: { id, teamId: teamId },
        data: updateData,
        include: {
          tags: { select: { id: true, name: true, color: true } },
        },
      });
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_UPDATE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    ...extractRequestMeta(req),
  });

  void dispatchWebhook({
    type: AUDIT_ACTION.ENTRY_UPDATE,
    teamId,
    timestamp: new Date().toISOString(),
    data: { entryId: id, entryType: updated.entryType },
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
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
    }),
  );

  if (!existing || existing.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  if (permanent) {
    await withTeamTenantRls(teamId, async () =>
      prisma.teamPasswordEntry.delete({ where: { id } }),
    );
  } else {
    await withTeamTenantRls(teamId, async () =>
      prisma.teamPasswordEntry.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    );
  }

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_DELETE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    metadata: { permanent },
    ...extractRequestMeta(req),
  });

  void dispatchWebhook({
    type: AUDIT_ACTION.ENTRY_DELETE,
    teamId,
    timestamp: new Date().toISOString(),
    data: { entryId: id, permanent },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
