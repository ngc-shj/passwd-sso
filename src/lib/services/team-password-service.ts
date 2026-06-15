/**
 * Team password service — Prisma query layer for team password entries.
 *
 * All functions in this module must be called within a `withTeamTenantRls()` context.
 */

import { prisma } from "@/lib/prisma";
import {
  collectEntryAttachmentRefs,
  type AttachmentBlobRef,
} from "@/lib/blob-store/cleanup";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma/prisma-filters";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { toBlobColumns, toOverviewColumns } from "@/lib/crypto/crypto-blob";
import type { EntryType } from "@prisma/client";
import { MS_PER_DAY } from "@/lib/constants/time";
import { TRASH_PURGE_BATCH_SIZE } from "@/lib/validations/common";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface EncryptedCiphertext {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface ListTeamPasswordsParams {
  userId?: string;
  tagId?: string | null;
  folderId?: string | null;
  entryType?: EntryType | null;
  favoritesOnly?: boolean;
  trashOnly?: boolean;
  archivedOnly?: boolean;
  includeBlob?: boolean;
}

export interface CreateTeamPasswordInput {
  id?: string;
  encryptedBlob: EncryptedCiphertext;
  encryptedOverview: EncryptedCiphertext;
  aadVersion: number;
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey?: EncryptedCiphertext | null;
  entryType: EntryType;
  userId: string;
  tagIds?: string[];
  teamFolderId?: string | null;
  requireReprompt?: boolean;
  expiresAt?: string | null;
}

export interface UpdateTeamPasswordInput {
  encryptedBlob?: EncryptedCiphertext;
  encryptedOverview?: EncryptedCiphertext;
  aadVersion?: number;
  teamKeyVersion?: number;
  itemKeyVersion?: number;
  encryptedItemKey?: EncryptedCiphertext | null;
  tagIds?: string[];
  teamFolderId?: string | null;
  isArchived?: boolean;
  requireReprompt?: boolean;
  expiresAt?: string | null;
  userId: string;
  // snapshot state of the existing entry (needed to write history)
  existingEntry: {
    tenantId: string;
    encryptedBlob: string;
    blobIv: string;
    blobAuthTag: string;
    aadVersion: number;
    teamKeyVersion: number;
    itemKeyVersion: number;
    encryptedItemKey: string | null;
    itemKeyIv: string | null;
    itemKeyAuthTag: string | null;
  };
}

// ---------------------------------------------------------------------------
// Validation errors — thrown by service functions, interpreted by route handlers
// ---------------------------------------------------------------------------

export class TeamPasswordServiceError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    public readonly statusHint: number,
  ) {
    super(code);
    this.name = "TeamPasswordServiceError";
  }
}

// ---------------------------------------------------------------------------
// Ownership guards (shared by create + update paths)
// ---------------------------------------------------------------------------

/** Reject if the folder does not belong to the given team. No-op when teamFolderId is nullish. */
function assertTeamFolderOwnership(
  teamFolderId: string | null | undefined,
  folder: { teamId: string } | null,
  teamId: string,
): void {
  if (!teamFolderId) return;
  if (!folder || folder.teamId !== teamId) {
    throw new TeamPasswordServiceError(API_ERROR.FOLDER_NOT_FOUND, 400);
  }
}

/** Reject if any tagId does not belong to the given team. No-op when tagIds is empty/undefined. */
async function assertTeamTagsOwnership(
  tagIds: string[] | undefined,
  teamId: string,
): Promise<void> {
  if (!tagIds?.length) return;
  // Normalize: a caller-supplied duplicate (e.g. ["t1","t1"]) should not
  // count as a missing tag. teamTag.count returns distinct row count, so
  // compare against the deduped input length, not the raw array length.
  const uniqueTagIds = [...new Set(tagIds)];
  const count = await prisma.teamTag.count({
    where: { id: { in: uniqueTagIds }, teamId },
  });
  if (count !== uniqueTagIds.length) {
    throw new TeamPasswordServiceError(API_ERROR.NOT_FOUND, 404);
  }
}

// ---------------------------------------------------------------------------
// listTeamPasswords
// ---------------------------------------------------------------------------

export async function listTeamPasswords(
  teamId: string,
  params: ListTeamPasswordsParams,
) {
  const {
    userId,
    tagId,
    folderId,
    entryType,
    favoritesOnly = false,
    trashOnly = false,
    archivedOnly = false,
    includeBlob = false,
  } = params;

  const passwords = await prisma.teamPasswordEntry.findMany({
    where: {
      teamId,
      ...(trashOnly
        ? { deletedAt: { not: null } }
        : archivedOnly
          ? { deletedAt: null, isArchived: true }
          : { ...ACTIVE_ENTRY_WHERE }),
      ...(favoritesOnly && userId
        ? { favorites: { some: { userId } } }
        : {}),
      ...(tagId ? { tags: { some: { id: tagId } } } : {}),
      ...(folderId ? { teamFolderId: folderId } : {}),
      ...(entryType ? { entryType } : {}),
    },
    include: {
      tags: { select: { id: true, name: true, color: true } },
      createdBy: { select: { id: true, name: true, email: true, image: true } },
      updatedBy: { select: { id: true, name: true, email: true } },
      favorites: {
        where: userId ? { userId } : { userId: "" },
        select: { id: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const entries = passwords.map((entry) => ({
    id: entry.id,
    entryType: entry.entryType,
    encryptedOverview: entry.encryptedOverview,
    overviewIv: entry.overviewIv,
    overviewAuthTag: entry.overviewAuthTag,
    ...(includeBlob
      ? {
          encryptedBlob: entry.encryptedBlob,
          blobIv: entry.blobIv,
          blobAuthTag: entry.blobAuthTag,
        }
      : {}),
    aadVersion: entry.aadVersion,
    teamKeyVersion: entry.teamKeyVersion,
    itemKeyVersion: entry.itemKeyVersion,
    ...(entry.itemKeyVersion >= 1
      ? {
          encryptedItemKey: entry.encryptedItemKey,
          itemKeyIv: entry.itemKeyIv,
          itemKeyAuthTag: entry.itemKeyAuthTag,
        }
      : {}),
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    tags: entry.tags,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: entry.deletedAt,
    requireReprompt: entry.requireReprompt,
    expiresAt: entry.expiresAt,
  }));

  // Sort: favorites first, then by updatedAt desc
  entries.sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return entries;
}

// ---------------------------------------------------------------------------
// purgeExpiredTeamPasswords (fire-and-forget helper used by GET list route)
// ---------------------------------------------------------------------------

/**
 * Delete trash older than 30 days for a team. Runs the DB work under the
 * caller's RLS context and returns the external blob refs to purge — the caller
 * must `deleteAttachmentBlobs(refs)` AFTER the RLS transaction closes, so
 * blob-store network I/O does not hold a DB tx open.
 */
export async function purgeExpiredTeamPasswords(
  teamId: string,
): Promise<AttachmentBlobRef[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY);
  // Cap per-request cleanup (parity with the personal GC) so a team with a
  // large trash backlog can't load/delete unboundedly on a list request;
  // remaining entries are purged on the next load.
  const expired = await prisma.teamPasswordEntry.findMany({
    where: { teamId, deletedAt: { lt: thirtyDaysAgo } },
    select: { id: true },
    take: TRASH_PURGE_BATCH_SIZE,
  });
  if (expired.length === 0) return [];

  // Capture external blob refs before the cascade delete removes the rows
  const refs = await collectEntryAttachmentRefs(prisma, {
    kind: "team",
    teamId,
    entryIds: expired.map((e) => e.id),
  });
  await prisma.teamPasswordEntry.deleteMany({
    where: { teamId, id: { in: expired.map((e) => e.id) } },
  });
  return refs;
}

// ---------------------------------------------------------------------------
// createTeamPassword
// ---------------------------------------------------------------------------

export async function createTeamPassword(
  teamId: string,
  input: CreateTeamPasswordInput,
) {
  const {
    id: clientId,
    encryptedBlob,
    encryptedOverview,
    aadVersion,
    teamKeyVersion,
    itemKeyVersion,
    encryptedItemKey,
    entryType,
    userId,
    tagIds,
    teamFolderId,
    requireReprompt,
    expiresAt,
  } = input;

  // Validate teamKeyVersion and folder ownership — fetch in parallel when both are needed
  const [team, folder] = await Promise.all([
    prisma.team.findUnique({
      where: { id: teamId },
      select: { teamKeyVersion: true, tenantId: true },
    }),
    teamFolderId
      ? prisma.teamFolder.findUnique({
          where: { id: teamFolderId },
          select: { teamId: true },
        })
      : Promise.resolve(null),
  ]);

  if (!team || teamKeyVersion !== team.teamKeyVersion) {
    throw new TeamPasswordServiceError(API_ERROR.TEAM_KEY_VERSION_MISMATCH, 409);
  }

  // tenantId is resolved from the team record, not passed by caller
  const tenantId = team.tenantId;

  assertTeamFolderOwnership(teamFolderId, folder, teamId);
  await assertTeamTagsOwnership(tagIds, teamId);

  // Use client-provided ID (bound into AAD during encryption) or generate one
  const entryId = clientId ?? crypto.randomUUID();

  return prisma.teamPasswordEntry.create({
    data: {
      id: entryId,
      ...toBlobColumns(encryptedBlob),
      ...toOverviewColumns(encryptedOverview),
      aadVersion,
      teamKeyVersion,
      itemKeyVersion,
      ...(encryptedItemKey
        ? {
            encryptedItemKey: encryptedItemKey.ciphertext,
            itemKeyIv: encryptedItemKey.iv,
            itemKeyAuthTag: encryptedItemKey.authTag,
          }
        : {}),
      entryType,
      teamId,
      tenantId,
      createdById: userId,
      updatedById: userId,
      ...(requireReprompt !== undefined ? { requireReprompt } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
      ...(teamFolderId ? { teamFolderId } : {}),
      ...(tagIds?.length
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
    },
    include: {
      tags: { select: { id: true, name: true, color: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// getTeamPassword
// ---------------------------------------------------------------------------

export async function getTeamPassword(
  teamId: string,
  passwordId: string,
  userId?: string,
) {
  return prisma.teamPasswordEntry.findUnique({
    where: { id: passwordId },
    include: {
      tags: { select: { id: true, name: true, color: true } },
      createdBy: { select: { id: true, name: true, email: true, image: true } },
      updatedBy: { select: { id: true, name: true, email: true } },
      favorites: {
        where: userId ? { userId } : { userId: "" },
        select: { id: true },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// getTeamPasswordForUpdate (fetches minimal fields needed for mutation guards)
// ---------------------------------------------------------------------------

export async function getTeamPasswordForUpdate(
  teamId: string,
  passwordId: string,
) {
  return prisma.teamPasswordEntry.findUnique({
    where: { id: passwordId },
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
  });
}

// ---------------------------------------------------------------------------
// updateTeamPassword
// ---------------------------------------------------------------------------

export async function updateTeamPassword(
  teamId: string,
  passwordId: string,
  input: UpdateTeamPasswordInput,
) {
  const {
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
    userId,
    existingEntry,
  } = input;

  const isFullUpdate = encryptedBlob !== undefined;

  // Prevent itemKeyVersion downgrade (v1→v0) — cryptographic downgrade attack
  if (itemKeyVersion !== undefined && itemKeyVersion < (existingEntry.itemKeyVersion ?? 0)) {
    throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_VERSION_DOWNGRADE, 400);
  }

  // C7: any change to itemKeyVersion / teamKeyVersion / aadVersion requires re-encryption.
  // Without encryptedBlob (isFullUpdate=false), changing these breaks AAD reconstruction.
  const itemKeyVersionChanged = itemKeyVersion !== undefined && itemKeyVersion !== (existingEntry.itemKeyVersion ?? 0);
  const teamKeyVersionChanged = teamKeyVersion !== undefined && teamKeyVersion !== existingEntry.teamKeyVersion;
  const aadVersionChanged = aadVersion !== undefined && aadVersion !== existingEntry.aadVersion;
  if ((itemKeyVersionChanged || teamKeyVersionChanged || aadVersionChanged) && !isFullUpdate) {
    throw new TeamPasswordServiceError(API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT, 409);
  }

  // Upgrading v0→v>=1 requires encryptedItemKey; reusing v>=1 does not
  const existingVersion = existingEntry.itemKeyVersion ?? 0;
  if (
    itemKeyVersion !== undefined &&
    itemKeyVersion >= 1 &&
    existingVersion < 1 &&
    !encryptedItemKey
  ) {
    throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_REQUIRED, 400);
  }

  // Re-wrap requirement: buildItemKeyWrapAAD binds the encryptedItemKey to
  // teamKeyVersion. If teamKeyVersion changes (rotation) and the entry holds
  // a wrapped item key (effective itemKeyVersion >= 1), the encryptedItemKey
  // MUST be re-wrapped with the new team key — otherwise the existing wrap's
  // AAD no longer matches and the item key (and thus the entry) becomes
  // undecryptable.
  const effectiveItemKeyVersion = itemKeyVersion ?? existingVersion;
  if (
    isFullUpdate &&
    teamKeyVersionChanged &&
    effectiveItemKeyVersion >= 1 &&
    !encryptedItemKey
  ) {
    throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_REQUIRED, 400);
  }

  // Validate teamKeyVersion and folder ownership — fetch in parallel when both are needed
  const [team, folder] = await Promise.all([
    isFullUpdate
      ? prisma.team.findUnique({
          where: { id: teamId },
          select: { teamKeyVersion: true },
        })
      : Promise.resolve(null),
    teamFolderId
      ? prisma.teamFolder.findUnique({
          where: { id: teamFolderId },
          select: { teamId: true },
        })
      : Promise.resolve(null),
  ]);

  if (isFullUpdate && (!team || teamKeyVersion !== team.teamKeyVersion)) {
    throw new TeamPasswordServiceError(API_ERROR.TEAM_KEY_VERSION_MISMATCH, 409);
  }

  assertTeamFolderOwnership(teamFolderId, folder, teamId);
  await assertTeamTagsOwnership(tagIds, teamId);

  const updateData: Record<string, unknown> = { updatedById: userId };

  if (isFullUpdate) {
    Object.assign(updateData, toBlobColumns(encryptedBlob!));
    Object.assign(updateData, toOverviewColumns(encryptedOverview!));
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

  // Row type for the FOR UPDATE snapshot read (team_password_entries).
  // item_key_* columns are nullable.
  type TeamBlobRow = {
    encrypted_blob: string;
    blob_iv: string;
    blob_auth_tag: string;
    aad_version: number;
    team_key_version: number;
    item_key_version: number;
    encrypted_item_key: string | null;
    item_key_iv: string | null;
    item_key_auth_tag: string | null;
  };

  // Snapshot + update in a single transaction for atomicity (F-9).
  // When the blob is changing, acquire a PK + team_id row lock first so
  // concurrent PUTs serialise here and each writer snapshots the immediately-
  // preceding committed blob (not the caller-supplied `existingEntry` read
  // from outside the transaction, which may be stale under contention).
  return prisma.$transaction(async (tx) => {
    if (isFullUpdate) {
      const [cur] = await tx.$queryRaw<TeamBlobRow[]>`
        SELECT encrypted_blob, blob_iv, blob_auth_tag,
               aad_version, team_key_version, item_key_version,
               encrypted_item_key, item_key_iv, item_key_auth_tag
        FROM team_password_entries
        WHERE id = ${passwordId}::uuid AND team_id = ${teamId}::uuid
        FOR UPDATE
      `;
      // Entry may be concurrently deleted between the caller's read and this lock.
      if (!cur) throw new TeamPasswordServiceError(API_ERROR.NOT_FOUND, 404);
      await tx.teamPasswordEntryHistory.create({
        data: {
          entryId: passwordId,
          tenantId: existingEntry.tenantId,
          encryptedBlob: cur.encrypted_blob,
          blobIv: cur.blob_iv,
          blobAuthTag: cur.blob_auth_tag,
          aadVersion: cur.aad_version,
          teamKeyVersion: cur.team_key_version,
          itemKeyVersion: cur.item_key_version,
          encryptedItemKey: cur.encrypted_item_key,
          itemKeyIv: cur.item_key_iv,
          itemKeyAuthTag: cur.item_key_auth_tag,
          changedById: userId,
        },
      });
      const all = await tx.teamPasswordEntryHistory.findMany({
        where: { entryId: passwordId },
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
      where: { id: passwordId, teamId },
      data: updateData,
      include: {
        tags: { select: { id: true, name: true, color: true } },
      },
    });
  });
}

// ---------------------------------------------------------------------------
// deleteTeamPassword
// ---------------------------------------------------------------------------

/**
 * Delete (or trash) a team entry under the caller's RLS context. For a
 * permanent delete, returns the external blob refs to purge — the caller must
 * `deleteAttachmentBlobs(refs)` AFTER the RLS transaction closes so blob-store
 * network I/O does not hold a DB tx open. Returns [] for a soft delete.
 */
export async function deleteTeamPassword(
  teamId: string,
  passwordId: string,
  permanent: boolean,
): Promise<AttachmentBlobRef[]> {
  if (permanent) {
    // Capture external blob refs before the cascade delete removes the rows
    const refs = await collectEntryAttachmentRefs(prisma, {
      kind: "team",
      teamId,
      entryIds: [passwordId],
    });
    // Scope the mutation by teamId (not the global PK alone) so a stale/mis-routed
    // caller or a broken RLS context cannot delete an entry belonging to another
    // team. Mirrors the id+teamId predicate used by updateTeamPassword.
    const deleted = await prisma.teamPasswordEntry.deleteMany({
      where: { id: passwordId, teamId },
    });
    if (deleted.count !== 1) {
      throw new TeamPasswordServiceError(API_ERROR.NOT_FOUND, 404);
    }
    return refs;
  }
  const trashed = await prisma.teamPasswordEntry.updateMany({
    where: { id: passwordId, teamId },
    data: { deletedAt: new Date() },
  });
  if (trashed.count !== 1) {
    throw new TeamPasswordServiceError(API_ERROR.NOT_FOUND, 404);
  }
  return [];
}
