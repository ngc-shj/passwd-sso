/**
 * Personal password service — Prisma write layer for personal password entries.
 *
 * Mirrors team-password-service's encapsulation so create semantics live in one
 * place instead of being inlined per route. All functions must be called within
 * a `withUserTenantRls()` context.
 */

import type { z } from "zod";
import type { TxOrPrisma } from "@/lib/prisma";
import { toBlobColumns, toOverviewColumns } from "@/lib/crypto/crypto-blob";
import type { createE2EPasswordSchema } from "@/lib/validations";

type CreatePersonalPasswordInput = z.infer<typeof createE2EPasswordSchema>;

export type CreatePersonalPasswordResult =
  | { ok: true; id: string }
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

  if (tagIds?.length) {
    const ownedCount = await db.tag.count({ where: { id: { in: tagIds }, userId } });
    if (ownedCount !== tagIds.length) return { ok: false, reason: "TAGS_NOT_OWNED" };
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
      ...(tagIds?.length
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
    },
    select: { id: true },
  });

  return { ok: true, id: entry.id };
}
