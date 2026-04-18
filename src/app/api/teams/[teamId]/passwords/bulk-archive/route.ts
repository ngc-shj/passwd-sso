import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, logAuditBulkAsync, teamAuditBase } from "@/lib/audit";
import { requireTeamPermission } from "@/lib/team-auth";
import { withRequestLog } from "@/lib/with-request-log";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { bulkArchiveSchema } from "@/lib/validations";

// POST /api/teams/[teamId]/passwords/bulk-archive - Archive/unarchive multiple team entries
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
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

  const result = await parseBody(req, bulkArchiveSchema);
  if (!result.ok) return result.response;

  const { ids, operation } = result.data;
  const toArchived = operation === "archive";

  const [entryIds, updateResult] = await withTeamTenantRls(teamId, () =>
    prisma.$transaction(async (tx) => {
      const entries = await tx.teamPasswordEntry.findMany({
        where: {
          teamId,
          id: { in: ids },
          deletedAt: null,
          isArchived: !toArchived,
        },
        select: { id: true },
      });
      const entryIds = entries.map((entry) => entry.id);
      const result = await tx.teamPasswordEntry.updateMany({
        where: {
          teamId,
          id: { in: entryIds },
          deletedAt: null,
          isArchived: !toArchived,
        },
        data: { isArchived: toArchived },
      });
      return [entryIds, result] as const;
    }),
  );

  const requestMeta = teamAuditBase(req, session.user.id, teamId);

  await logAuditAsync({
    ...requestMeta,
    action: toArchived
      ? AUDIT_ACTION.ENTRY_BULK_ARCHIVE
      : AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    // targetId omitted for bulk operations
    metadata: {
      bulk: true,
      operation,
      requestedCount: ids.length,
      processedCount: updateResult.count,
      archivedCount: toArchived ? updateResult.count : 0,
      unarchivedCount: toArchived ? 0 : updateResult.count,
      entryIds,
    },
  });

  await logAuditBulkAsync(
    entryIds.map((entryId) => ({
      ...requestMeta,
      action: AUDIT_ACTION.ENTRY_UPDATE,
      targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-archive",
        parentAction: toArchived
          ? AUDIT_ACTION.ENTRY_BULK_ARCHIVE
          : AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
      },
    })),
  );

  return NextResponse.json({
    success: true,
    operation,
    processedCount: updateResult.count,
    archivedCount: toArchived ? updateResult.count : 0,
    unarchivedCount: toArchived ? 0 : updateResult.count,
  });
}

export const POST = withRequestLog(handlePOST);
