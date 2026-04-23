/**
 * Team password service — Prisma query layer for team password entries.
 *
 * All functions in this module must be called within a `withTeamTenantRls()` context.
 */

import { prisma } from "@/lib/prisma";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma/prisma-filters";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { toBlobColumns, toOverviewColumns } from "@/lib/crypto/crypto-blob";
import type { EntryType } from "@prisma/client";
import { MS_PER_DAY } from "@/lib/constants/time";

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

export async function purgeExpiredTeamPasswords(teamId: string): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY);
  await prisma.teamPasswordEntry.deleteMany({
    where: {
      teamId,
      deletedAt: { lt: thirtyDaysAgo },
    },
  });
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

  if (teamFolderId && (!folder || folder.teamId !== teamId)) {
    throw new TeamPasswordServiceError(API_ERROR.FOLDER_NOT_FOUND, 400);
  }

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

  if (teamFolderId && (!folder || folder.teamId !== teamId)) {
    throw new TeamPasswordServiceError(API_ERROR.FOLDER_NOT_FOUND, 400);
  }

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

  // Snapshot + update in a single transaction for atomicity (F-9)
  return prisma.$transaction(async (tx) => {
    if (isFullUpdate) {
      await tx.teamPasswordEntryHistory.create({
        data: {
          entryId: passwordId,
          tenantId: existingEntry.tenantId,
          encryptedBlob: existingEntry.encryptedBlob,
          blobIv: existingEntry.blobIv,
          blobAuthTag: existingEntry.blobAuthTag,
          aadVersion: existingEntry.aadVersion,
          teamKeyVersion: existingEntry.teamKeyVersion,
          itemKeyVersion: existingEntry.itemKeyVersion,
          encryptedItemKey: existingEntry.encryptedItemKey,
          itemKeyIv: existingEntry.itemKeyIv,
          itemKeyAuthTag: existingEntry.itemKeyAuthTag,
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

export async function deleteTeamPassword(
  teamId: string,
  passwordId: string,
  permanent: boolean,
): Promise<void> {
  if (permanent) {
    await prisma.teamPasswordEntry.delete({ where: { id: passwordId } });
  } else {
    await prisma.teamPasswordEntry.update({
      where: { id: passwordId },
      data: { deletedAt: new Date() },
    });
  }
}
