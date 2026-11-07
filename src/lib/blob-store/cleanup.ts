import { getAttachmentBlobStore, BLOB_STORAGE } from "@/lib/blob-store";
import { decodeObjectRef, validateObjectRefKey } from "@/lib/blob-store/object-ref";
import type { AttachmentBlobContext } from "@/lib/blob-store/types";
import { getLogger } from "@/lib/logger";
import type { TxOrPrisma } from "@/lib/prisma";

export interface AttachmentBlobRef {
  stored: Uint8Array;
  context: AttachmentBlobContext;
}

type EntryScope =
  | { kind: "personal"; entryIds: string[] }
  | { kind: "team"; teamId: string; entryIds: string[] };

/**
 * Capture external blob-store references for all attachments of the given
 * entries BEFORE the DB cascade delete removes the Attachment rows. Returns []
 * on the DB backend (the cascade covers the inline bytes column), so callers
 * can skip the delete step entirely. Must run under the same RLS context as
 * the entry delete.
 */
export async function collectEntryAttachmentRefs(
  client: TxOrPrisma,
  scope: EntryScope,
): Promise<AttachmentBlobRef[]> {
  if (scope.entryIds.length === 0) return [];
  const blobStore = getAttachmentBlobStore();
  if (blobStore.backend === BLOB_STORAGE.DB) return [];

  const attachments = await client.attachment.findMany({
    where:
      scope.kind === "team"
        ? { teamPasswordEntryId: { in: scope.entryIds } }
        : { passwordEntryId: { in: scope.entryIds } },
    select: {
      id: true,
      encryptedData: true,
      passwordEntryId: true,
      teamPasswordEntryId: true,
    },
  });

  return attachments.map((a) => ({
    stored: a.encryptedData,
    context: {
      attachmentId: a.id,
      entryId: (scope.kind === "team"
        ? a.teamPasswordEntryId
        : a.passwordEntryId)!,
      ...(scope.kind === "team" ? { teamId: scope.teamId } : {}),
    },
  }));
}

/**
 * Collect external blob refs for every attachment created by a user, BEFORE a
 * full vault reset deletes them by `createdById`. Returns [] on the DB backend.
 * The context names the row (its team for a team attachment), against which
 * deleteAttachmentBlobs validates the stored object key.
 */
export async function collectAttachmentRefsByCreator(
  client: TxOrPrisma,
  createdById: string,
): Promise<AttachmentBlobRef[]> {
  const blobStore = getAttachmentBlobStore();
  if (blobStore.backend === BLOB_STORAGE.DB) return [];

  const attachments = await client.attachment.findMany({
    where: { createdById },
    select: {
      id: true,
      encryptedData: true,
      passwordEntryId: true,
      teamPasswordEntryId: true,
      teamPasswordEntry: { select: { teamId: true } },
    },
  });

  return attachments.map((a) => ({
    stored: a.encryptedData,
    context: {
      attachmentId: a.id,
      entryId: (a.passwordEntryId ?? a.teamPasswordEntryId)!,
      ...(a.teamPasswordEntry ? { teamId: a.teamPasswordEntry.teamId } : {}),
    },
  }));
}

/**
 * Best-effort deletion of external blob-store objects. Storage failures are
 * swallowed (Promise.allSettled): the DB delete has already happened, and an
 * orphaned object is preferable to surfacing a failed user-facing delete.
 *
 * A ref that does not decode, or names an object other than its row's own,
 * is skipped and logged rather than deleted: refs are not trusted to point
 * where they should, and a computed key would be a guess. The log names the
 * attachment only, never the ref.
 */
export async function deleteAttachmentBlobs(
  refs: AttachmentBlobRef[],
): Promise<void> {
  if (refs.length === 0) return;
  const blobStore = getAttachmentBlobStore();
  // The DB backend keeps bytes, not refs: there is no external object.
  if (blobStore.backend === BLOB_STORAGE.DB) return;
  const valid = refs.filter((r) => {
    const ref = decodeObjectRef(r.stored);
    if (ref && validateObjectRefKey(ref.key, r.context)) return true;
    getLogger().warn(
      { attachmentId: r.context.attachmentId },
      "blob-store.cleanup.invalid_ref_skipped",
    );
    return false;
  });
  await Promise.allSettled(
    valid.map((r) => blobStore.deleteObject(r.stored, r.context)),
  );
}
