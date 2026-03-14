import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { withRequestLog } from "@/lib/with-request-log";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { errorResponse, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { bulkIdsSchema } from "@/lib/validations";

// POST /api/teams/[teamId]/passwords/bulk-restore - Restore multiple team entries from trash
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

  const result = await parseBody(req, bulkIdsSchema);
  if (!result.ok) return result.response;

  const { ids } = result.data;

  const entriesToRestore = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId,
        id: { in: ids },
        deletedAt: { not: null },
      },
      select: { id: true },
    }),
  );
  const entryIds = entriesToRestore.map((entry) => entry.id);

  const updateResult = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.updateMany({
      where: {
        teamId,
        id: { in: entryIds },
        deletedAt: { not: null },
      },
      data: {
        deletedAt: null,
      },
    }),
  );

  // Re-fetch to get accurate list of actually restored entries
  const restoredEntries = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId,
        id: { in: entryIds },
        deletedAt: null,
      },
      select: { id: true },
    }),
  );
  const restoredEntryIds = restoredEntries.map((e) => e.id);

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_BULK_RESTORE,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: {
      bulk: true,
      operation: "restore",
      requestedCount: ids.length,
      restoredCount: updateResult.count,
      entryIds: restoredEntryIds,
    },
    ...requestMeta,
  });

  for (const entryId of restoredEntryIds) {
    logAudit({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_RESTORE,
      userId: session.user.id,
      teamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-restore",
        parentAction: AUDIT_ACTION.ENTRY_BULK_RESTORE,
      },
      ...requestMeta,
    });
  }

  return NextResponse.json({ success: true, restoredCount: updateResult.count });
}

export const POST = withRequestLog(handlePOST);
