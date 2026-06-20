/**
 * Personal password service — Prisma write layer for personal password entries.
 *
 * Mirrors team-password-service's encapsulation so create semantics live in one
 * place instead of being inlined per route. All functions must be called within
 * a `withUserTenantRls()` context.
 */

import type { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { TxOrPrisma } from "@/lib/prisma";
import { toBlobColumns, toOverviewColumns } from "@/lib/crypto/crypto-blob";
import { dedupeTagIds, tagConnect } from "@/lib/services/tag-relation";
import type { createE2EPasswordSchema } from "@/lib/validations";

type CreatePersonalPasswordInput = z.infer<typeof createE2EPasswordSchema>;

/** The created entry plus its tag ids — covers both the single-create response
 * (POST /api/passwords) and the bulk-import path (which only reads `id`). */
export type CreatedPersonalEntry = Prisma.PasswordEntryGetPayload<{
  include: { tags: { select: { id: true } } };
}>;

export type CreatePersonalPasswordResult =
  | { ok: true; entry: CreatedPersonalEntry }
  | { ok: false; reason: "FOLDER_NOT_FOUND" | "TAGS_NOT_OWNED" };

/**
 * Create one personal password entry. Verifies folder/tag ownership against the
 * caller before insert. Caller must already be inside `withUserTenantRls`.
 */
export async function createPersonalPasswordEntry(
  db: TxOrPrisma,
  userId: string,
  tenantId: string,
  input: CreatePersonalPasswordInput,
): Promise<CreatePersonalPasswordResult> {
  const {
    id: clientId,
    encryptedBlob,
    encryptedOverview,
    keyVersion,
    aadVersion,
    tagIds,
    folderId,
    isFavorite,
    entryType,
    requireReprompt,
    expiresAt,
  } = input;

  if (folderId) {
    const folder = await db.folder.findFirst({ where: { id: folderId, userId } });
    if (!folder) return { ok: false, reason: "FOLDER_NOT_FOUND" };
  }

  // Normalize duplicates: a caller-supplied duplicate (e.g. ["t1","t1"])
  // should not count as a missing tag — tag.count returns distinct row count,
  // so compare against the deduped input length, not the raw array length.
  // Mirrors team-password-service.ts.
  const uniqueTagIds = tagIds?.length ? dedupeTagIds(tagIds) : [];
  if (uniqueTagIds.length) {
    const ownedCount = await db.tag.count({ where: { id: { in: uniqueTagIds }, userId } });
    if (ownedCount !== uniqueTagIds.length) return { ok: false, reason: "TAGS_NOT_OWNED" };
  }

  const entry = await db.passwordEntry.create({
    data: {
      ...(clientId ? { id: clientId } : {}),
      ...toBlobColumns(encryptedBlob),
      ...toOverviewColumns(encryptedOverview),
      keyVersion,
      aadVersion,
      entryType,
      ...(isFavorite !== undefined ? { isFavorite } : {}),
      ...(requireReprompt !== undefined ? { requireReprompt } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
      ...(folderId ? { folderId } : {}),
      userId,
      tenantId,
      ...(uniqueTagIds.length ? { tags: tagConnect(uniqueTagIds) } : {}),
    },
    include: { tags: { select: { id: true } } },
  });

  return { ok: true, entry };
}
