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
import { dedupeTagIds, tagConnect, tagSet } from "@/lib/services/tag-relation";
import { lockTeamKeyVersion, TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";
import { itemKeyIdsMatch, itemKeyIvReused, nextItemKeyVersion, normalizeTeamKeyVersion } from "@/lib/team/team-item-key";
import { activeTeamRole, canWriteTeamEntry } from "@/lib/auth/access/team-auth";
import type { EntryType, Prisma } from "@prisma/client";

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
  /** The ItemKey a full update that reuses it was encrypted under. */
  itemKeyId?: string | null;
  /** blobIv the client read; identifies a v0→v1 upgrade with `encryptedItemKey`. */
  snapshotBlobIv?: string;
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
  const uniqueTagIds = dedupeTagIds(tagIds);
  const count = await prisma.teamTag.count({
    where: { id: { in: uniqueTagIds }, teamId },
  });
  if (count !== uniqueTagIds.length) {
    throw new TeamPasswordServiceError(API_ERROR.NOT_FOUND, 404);
  }
}

/**
 * Reject a team-entry write whose `teamKeyVersion` is not the team's current
 * one, holding the team row FOR SHARE until the transaction ends so the
 * write serialises with rotation (see team-key-rotation-lock.ts) — the team
 * twin of `assertCurrentKeyVersion`. A rotation that holds the row past the
 * lock timeout answers the same 409: the client refetches the team key.
 */
async function assertCurrentTeamKeyVersion(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  teamId: string,
  // A full update whose caller omitted the version never matches.
  teamKeyVersion: number | undefined,
): Promise<{ tenantId: string; teamKeyVersion: number }> {
  let team: Awaited<ReturnType<typeof lockTeamKeyVersion>>;
  try {
    team = await lockTeamKeyVersion(tx, teamId);
  } catch (e) {
    if (e instanceof TeamRotationInProgressError) {
      throw new TeamPasswordServiceError(API_ERROR.TEAM_KEY_VERSION_MISMATCH, 409);
    }
    throw e;
  }
  if (!team || team.teamKeyVersion !== teamKeyVersion) {
    throw new TeamPasswordServiceError(API_ERROR.TEAM_KEY_VERSION_MISMATCH, 409);
  }
  return { tenantId: team.tenantId, teamKeyVersion: team.teamKeyVersion };
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
    // No creator or updater relation: a guest from another primary tenant, or a
    // member who has since left, has a users row RLS hides in the team context, and
    // the REQUIRED relation comes back null (Prisma does not throw). The caller
    // hydrates both ids after the context closes.
    include: {
      tags: { select: { id: true, name: true, color: true } },
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
    // Keys the client ItemKey cache (C5); null never caches.
    itemKeyId: entry.itemKeyId,
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    tags: entry.tags,
    createdById: entry.createdById,
    updatedById: entry.updatedById,
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

  // Validate teamKeyVersion (locked against rotation) and folder ownership.
  // `prisma` resolves to the caller's withTeamTenantRls transaction, which
  // holds the FOR SHARE until the entry insert commits.
  // tenantId is resolved from the team record, not passed by caller.
  const { tenantId, teamKeyVersion: currentTeamKeyVersion } = await assertCurrentTeamKeyVersion(
    prisma,
    teamId,
    teamKeyVersion,
  );
  const folder = teamFolderId
    ? await prisma.teamFolder.findUnique({
        where: { id: teamFolderId },
        select: { teamId: true },
      })
    : null;

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
      // A new entry's ItemKey (if any) is created under the current team key:
      // the server mints its identity, and the entry is not pending re-key.
      ...(itemKeyVersion >= 1 ? { itemKeyId: crypto.randomUUID() } : {}),
      itemKeyTeamKeyVersion: normalizeTeamKeyVersion(currentTeamKeyVersion),
      itemKeyVersionHighWater: itemKeyVersion,
      entryType,
      teamId,
      tenantId,
      createdById: userId,
      updatedById: userId,
      ...(requireReprompt !== undefined ? { requireReprompt } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
      ...(teamFolderId ? { teamFolderId } : {}),
      ...(tagIds?.length ? { tags: tagConnect(tagIds) } : {}),
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
    // Creator and updater are hydrated by the caller; see listTeamPasswords.
    include: {
      tags: { select: { id: true, name: true, color: true } },
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

// Row type for the FOR UPDATE read of the entry (team_password_entries).
// item_key_* wrap columns and item_key_id are nullable.
type LockedTeamEntryRow = {
  encrypted_blob: string;
  blob_iv: string;
  blob_auth_tag: string;
  aad_version: number;
  team_key_version: number;
  item_key_version: number;
  encrypted_item_key: string | null;
  item_key_iv: string | null;
  item_key_auth_tag: string | null;
  item_key_id: string | null;
  item_key_team_key_version: number;
  item_key_version_high_water: number;
  created_by_id: string;
};

/**
 * The ItemKey columns a full update writes, decided against the LOCKED row
 * (plan C1/C6). Three shapes:
 *  - v0→v1 upgrade: the locked row is v0 and the body carries a new wrap
 *    plus the blobIv it read. The version must be high-water + 1 and the wrap
 *    IV unused by the row and its history; a fresh `item_key_id` is minted and
 *    the re-key marker is left as it was.
 *  - legacy v0 edit: no ItemKey before or after.
 *  - reuse of the entry's ItemKey: the body's `itemKeyId` must be the locked
 *    one (checked before the team-key-version rule, so a stale client learns
 *    the key changed), and an ItemKey wrapped under an older team key must be
 *    re-keyed before it is written to again.
 */
async function resolveFullUpdateItemKey(
  tx: Pick<Prisma.TransactionClient, "teamPasswordEntryHistory">,
  passwordId: string,
  cur: LockedTeamEntryRow,
  currentTeamKeyVersion: number,
  body: {
    itemKeyVersion: number | undefined;
    encryptedItemKey: EncryptedCiphertext | null | undefined;
    itemKeyId: string | null | undefined;
    snapshotBlobIv: string | undefined;
  },
): Promise<Record<string, unknown>> {
  const requested = body.itemKeyVersion ?? cur.item_key_version;
  // Prevent itemKeyVersion downgrade (v1→v0) — cryptographic downgrade attack
  if (requested < cur.item_key_version) {
    throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_VERSION_DOWNGRADE, 400);
  }

  if (body.encryptedItemKey) {
    if (
      cur.item_key_version !== 0 ||
      body.snapshotBlobIv === undefined ||
      body.snapshotBlobIv.toLowerCase() !== cur.blob_iv.toLowerCase()
    ) {
      throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_CHANGED, 409);
    }
    if (requested !== nextItemKeyVersion(cur.item_key_version_high_water, cur.item_key_version)) {
      throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_VERSION_INVALID, 409);
    }
    if (await itemKeyIvReused(tx, passwordId, cur.item_key_iv, body.encryptedItemKey.iv)) {
      throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_IV_REUSED, 400);
    }
    return {
      itemKeyVersion: requested,
      encryptedItemKey: body.encryptedItemKey.ciphertext,
      itemKeyIv: body.encryptedItemKey.iv,
      itemKeyAuthTag: body.encryptedItemKey.authTag,
      itemKeyId: crypto.randomUUID(),
      itemKeyVersionHighWater: requested,
    };
  }

  if (requested === 0) return { itemKeyVersion: 0 };

  if (!itemKeyIdsMatch(body.itemKeyId, cur.item_key_id)) {
    throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_CHANGED, 409);
  }
  if (requested !== cur.item_key_version) {
    throw new TeamPasswordServiceError(API_ERROR.ITEM_KEY_VERSION_INVALID, 409);
  }
  if (normalizeTeamKeyVersion(cur.team_key_version) !== normalizeTeamKeyVersion(currentTeamKeyVersion)) {
    throw new TeamPasswordServiceError(API_ERROR.ENTRY_REKEY_REQUIRED, 409);
  }
  return { itemKeyVersion: requested };
}

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
    itemKeyId,
    snapshotBlobIv,
    tagIds,
    teamFolderId,
    isArchived,
    requireReprompt,
    expiresAt,
    userId,
    existingEntry,
  } = input;

  const isFullUpdate = encryptedBlob !== undefined;

  // C7: any change to itemKeyVersion / teamKeyVersion / aadVersion requires re-encryption.
  // Without encryptedBlob (isFullUpdate=false), changing these breaks AAD reconstruction.
  // A metadata-only update writes no key material, so it is exempt from the
  // ItemKey identity and re-key checks a full update runs under the lock.
  const itemKeyVersionChanged = itemKeyVersion !== undefined && itemKeyVersion !== (existingEntry.itemKeyVersion ?? 0);
  const teamKeyVersionChanged = teamKeyVersion !== undefined && teamKeyVersion !== existingEntry.teamKeyVersion;
  const aadVersionChanged = aadVersion !== undefined && aadVersion !== existingEntry.aadVersion;
  if ((itemKeyVersionChanged || teamKeyVersionChanged || aadVersionChanged) && !isFullUpdate) {
    throw new TeamPasswordServiceError(API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT, 409);
  }

  // teamKeyVersion and the ItemKey are validated inside the transaction below, under the locks.
  const folder = teamFolderId
    ? await prisma.teamFolder.findUnique({
        where: { id: teamFolderId },
        select: { teamId: true },
      })
    : null;

  assertTeamFolderOwnership(teamFolderId, folder, teamId);
  await assertTeamTagsOwnership(tagIds, teamId);

  const updateData: Record<string, unknown> = { updatedById: userId };

  if (isFullUpdate) {
    Object.assign(updateData, toBlobColumns(encryptedBlob!));
    Object.assign(updateData, toOverviewColumns(encryptedOverview!));
    updateData.aadVersion = aadVersion;
    updateData.teamKeyVersion = teamKeyVersion;
  }

  if (teamFolderId !== undefined) updateData.teamFolderId = teamFolderId;
  if (isArchived !== undefined) updateData.isArchived = isArchived;
  if (requireReprompt !== undefined) updateData.requireReprompt = requireReprompt;
  if (expiresAt !== undefined) updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
  if (tagIds !== undefined) {
    updateData.tags = tagSet(tagIds);
  }

  // Snapshot + update in a single transaction for atomicity (F-9).
  // When the blob is changing, acquire a PK + team_id row lock first so
  // concurrent PUTs serialise here and each writer snapshots the immediately-
  // preceding committed blob (not the caller-supplied `existingEntry` read
  // from outside the transaction, which may be stale under contention).
  return prisma.$transaction(async (tx) => {
    if (isFullUpdate) {
      // Lock order: teams FOR SHARE first, then the entry FOR UPDATE.
      const team = await assertCurrentTeamKeyVersion(tx, teamId, teamKeyVersion);
      const [cur] = await tx.$queryRaw<LockedTeamEntryRow[]>`
        SELECT encrypted_blob, blob_iv, blob_auth_tag,
               aad_version, team_key_version, item_key_version,
               encrypted_item_key, item_key_iv, item_key_auth_tag,
               item_key_id, item_key_team_key_version, item_key_version_high_water,
               created_by_id
        FROM team_password_entries
        WHERE id = ${passwordId}::uuid AND team_id = ${teamId}::uuid
        FOR UPDATE
      `;
      // Entry may be concurrently deleted between the caller's read and this lock.
      if (!cur) throw new TeamPasswordServiceError(API_ERROR.NOT_FOUND, 404);
      // The route's permission and own-entry checks ran before the locks; a
      // removal, departure or demotion committed since would otherwise write
      // key material the actor no longer may.
      const role = await activeTeamRole(tx, teamId, userId);
      if (!role || !canWriteTeamEntry(role, cur.created_by_id, userId)) {
        throw new TeamPasswordServiceError(API_ERROR.ACTOR_NOT_PERMITTED, 403);
      }
      Object.assign(
        updateData,
        await resolveFullUpdateItemKey(tx, passwordId, cur, team.teamKeyVersion, {
          itemKeyVersion,
          encryptedItemKey,
          itemKeyId,
          snapshotBlobIv,
        }),
      );
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
          itemKeyId: cur.item_key_id,
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
          where: { entryId: passwordId, id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
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
