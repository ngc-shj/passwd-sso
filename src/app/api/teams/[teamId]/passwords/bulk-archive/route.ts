import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, logAuditBatch, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { withRequestLog } from "@/lib/with-request-log";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { errorResponse, unauthorized } from "@/lib/api-response";
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
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
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

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: toArchived
      ? AUDIT_ACTION.ENTRY_BULK_ARCHIVE
      : AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: null,
    metadata: {
      bulk: true,
      operation,
      requestedCount: ids.length,
      processedCount: updateResult.count,
      archivedCount: toArchived ? updateResult.count : 0,
      unarchivedCount: toArchived ? 0 : updateResult.count,
      entryIds,
    },
    ...requestMeta,
  });

  logAuditBatch(
    entryIds.map((entryId) => ({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_UPDATE,
      userId: session.user.id,
      teamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-archive",
        parentAction: toArchived
          ? AUDIT_ACTION.ENTRY_BULK_ARCHIVE
          : AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
      },
      ...requestMeta,
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
