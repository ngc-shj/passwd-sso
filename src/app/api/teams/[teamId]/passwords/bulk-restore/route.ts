import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

interface BulkRestoreBody {
  ids: string[];
}

// POST /api/teams/[teamId]/passwords/bulk-restore - Restore multiple team entries from trash
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

  const ids = Array.isArray((body as BulkRestoreBody)?.ids)
    ? Array.from(
        new Set(
          (body as BulkRestoreBody).ids.filter(
            (id) => typeof id === "string" && id.length > 0
          )
        )
      )
    : [];

  const MAX_BULK_IDS = 100;
  if (ids.length === 0 || ids.length > MAX_BULK_IDS) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  const entriesToRestore = await withUserTenantRls(session.user.id, async () =>
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

  const result = await withUserTenantRls(session.user.id, async () =>
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
  const restoredEntries = await withUserTenantRls(session.user.id, async () =>
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
      restoredCount: result.count,
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

  return NextResponse.json({ success: true, restoredCount: result.count });
}

export const POST = withRequestLog(handlePOST);
