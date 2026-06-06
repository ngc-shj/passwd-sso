import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, logAuditBulkAsync, personalAuditBase } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  collectEntryAttachmentRefs,
  deleteAttachmentBlobs,
  type AttachmentBlobRef,
} from "@/lib/blob-store/cleanup";
import { unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { bulkIdsSchema } from "@/lib/validations";

// POST /api/passwords/bulk-purge - Permanently delete selected entries from trash.
// Like empty-trash, but scoped to the supplied ids. Only entries already in trash
// (deletedAt != null) are eligible — this never bypasses soft-delete.
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await parseBody(req, bulkIdsSchema);
  if (!result.ok) return result.response;

  const { ids } = result.data;

  // Atomic findMany + deleteMany to prevent TOCTOU race.
  const { entryIds, deletedCount, attachmentRefs } = await withUserTenantRls(
    session.user.id,
    async (): Promise<{ entryIds: string[]; deletedCount: number; attachmentRefs: AttachmentBlobRef[] }> => {
      const [entries, deleted, refs] = await prisma.$transaction(async (tx) => {
        const found = await tx.passwordEntry.findMany({
          where: { userId: session.user.id, id: { in: ids }, deletedAt: { not: null } },
          select: { id: true },
        });
        const foundIds = found.map((e) => e.id);
        // Capture external blob refs before the cascade delete removes the rows.
        const blobRefs = await collectEntryAttachmentRefs(tx, {
          kind: "personal",
          entryIds: foundIds,
        });
        const removed = await tx.passwordEntry.deleteMany({
          where: { userId: session.user.id, id: { in: foundIds }, deletedAt: { not: null } },
        });
        return [found, removed, blobRefs] as const;
      });
      return { entryIds: entries.map((e) => e.id), deletedCount: deleted.count, attachmentRefs: refs };
    },
  );

  await deleteAttachmentBlobs(attachmentRefs);

  const requestMeta = personalAuditBase(req, session.user.id);

  await logAuditAsync({
    ...requestMeta,
    action: AUDIT_ACTION.ENTRY_BULK_PURGE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    // targetId omitted for bulk operations
    metadata: {
      bulk: true,
      operation: "bulk-purge",
      requestedCount: ids.length,
      deletedCount,
      entryIds,
    },
  });

  await logAuditBulkAsync(
    entryIds.map((entryId) => ({
      ...requestMeta,
      action: AUDIT_ACTION.ENTRY_PERMANENT_DELETE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-purge",
        parentAction: AUDIT_ACTION.ENTRY_BULK_PURGE,
      },
    })),
  );

  return NextResponse.json({ success: true, deletedCount });
}

export const POST = withRequestLog(handlePOST);
