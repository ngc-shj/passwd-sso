import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";

interface BulkArchiveBody {
  ids: string[];
  operation?: "archive" | "unarchive";
}

// POST /api/teams/[teamId]/passwords/bulk-archive - Archive/unarchive multiple team entries
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const ids = Array.isArray((body as BulkArchiveBody)?.ids)
    ? Array.from(
        new Set(
          (body as BulkArchiveBody).ids.filter(
            (id) => typeof id === "string" && id.length > 0
          )
        )
      )
    : [];
  const operation =
    (body as BulkArchiveBody)?.operation === "unarchive"
      ? "unarchive"
      : "archive";
  const toArchived = operation === "archive";

  const MAX_BULK_IDS = 100;
  if (ids.length === 0 || ids.length > MAX_BULK_IDS) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  const entriesToProcess = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId,
        id: { in: ids },
        deletedAt: null,
        isArchived: !toArchived,
      },
      select: { id: true },
    }),
  );
  const entryIds = entriesToProcess.map((entry) => entry.id);

  const result = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.updateMany({
      where: {
        teamId,
        id: { in: entryIds },
        deletedAt: null,
        isArchived: !toArchived,
      },
      data: {
        isArchived: toArchived,
      },
    }),
  );

  // Re-fetch to get accurate list of actually processed entries
  const processedEntries = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId,
        id: { in: entryIds },
        isArchived: toArchived,
      },
      select: { id: true },
    }),
  );
  const processedEntryIds = processedEntries.map((e) => e.id);

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: toArchived
      ? AUDIT_ACTION.ENTRY_BULK_ARCHIVE
      : AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: {
      bulk: true,
      operation,
      requestedCount: ids.length,
      processedCount: result.count,
      archivedCount: toArchived ? result.count : 0,
      unarchivedCount: toArchived ? 0 : result.count,
      entryIds: processedEntryIds,
    },
    ...requestMeta,
  });

  for (const entryId of processedEntryIds) {
    logAudit({
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
    });
  }

  return NextResponse.json({
    success: true,
    operation,
    processedCount: result.count,
    archivedCount: toArchived ? result.count : 0,
    unarchivedCount: toArchived ? 0 : result.count,
  });
}

export const POST = withRequestLog(handlePOST);
