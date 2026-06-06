import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { logAuditAsync, logAuditBulkAsync, teamAuditBase } from "@/lib/audit/audit";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_TARGET_TYPE,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import {
  collectEntryAttachmentRefs,
  deleteAttachmentBlobs,
  type AttachmentBlobRef,
} from "@/lib/blob-store/cleanup";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { bulkIdsSchema } from "@/lib/validations";

type Params = { params: Promise<{ teamId: string }> };

// POST /api/teams/[teamId]/passwords/bulk-purge — Permanently delete selected
// trashed entries. Like empty-trash, but scoped to the supplied ids.
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const result = await parseBody(req, bulkIdsSchema);
  if (!result.ok) return result.response;

  const { ids } = result.data;

  // Atomic findMany + deleteMany to prevent TOCTOU race.
  const { entryIds, deletedCount, attachmentRefs } = await withTeamTenantRls(teamId, async (): Promise<{ entryIds: string[]; deletedCount: number; attachmentRefs: AttachmentBlobRef[] }> => {
    const [entries, deleted, refs] = await prisma.$transaction(async (tx) => {
      const found = await tx.teamPasswordEntry.findMany({
        where: { teamId, id: { in: ids }, deletedAt: { not: null } },
        select: { id: true },
      });
      const foundIds = found.map((e) => e.id);
      // Capture external blob refs before the cascade delete removes the rows.
      const blobRefs = await collectEntryAttachmentRefs(tx, {
        kind: "team",
        teamId,
        entryIds: foundIds,
      });
      const removed = await tx.teamPasswordEntry.deleteMany({
        where: { teamId, id: { in: foundIds }, deletedAt: { not: null } },
      });
      return [found, removed, blobRefs] as const;
    });
    return { entryIds: entries.map((e) => e.id), deletedCount: deleted.count, attachmentRefs: refs };
  });

  await deleteAttachmentBlobs(attachmentRefs);

  const requestMeta = teamAuditBase(req, session.user.id, teamId);

  await logAuditAsync({
    ...requestMeta,
    action: AUDIT_ACTION.ENTRY_BULK_PURGE,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
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
      targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
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
