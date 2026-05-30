import { getAttachmentBlobStore, BLOB_STORAGE } from "@/lib/blob-store";
import type { AttachmentBlobContext } from "@/lib/blob-store/types";
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
 * Relies on the object key encoded in the stored payload (the normal case); the
 * context is only a legacy fallback.
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
    },
  });

  return attachments.map((a) => ({
    stored: a.encryptedData,
    context: {
      attachmentId: a.id,
      entryId: (a.passwordEntryId ?? a.teamPasswordEntryId)!,
    },
  }));
}

/**
 * Best-effort deletion of external blob-store objects. Storage failures are
 * swallowed (Promise.allSettled): the DB delete has already happened, and an
 * orphaned object is preferable to surfacing a failed user-facing delete.
 */
export async function deleteAttachmentBlobs(
  refs: AttachmentBlobRef[],
): Promise<void> {
  if (refs.length === 0) return;
  const blobStore = getAttachmentBlobStore();
  await Promise.allSettled(
    refs.map((r) => blobStore.deleteObject(r.stored, r.context)),
  );
}
