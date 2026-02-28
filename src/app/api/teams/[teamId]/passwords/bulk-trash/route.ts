import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";

interface BulkTrashBody {
  ids: string[];
}

// POST /api/teams/[teamId]/passwords/bulk-trash - Soft delete multiple team entries (move to trash)
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

  const MAX_BULK_IDS = 100;
  const ids = Array.isArray((body as BulkTrashBody)?.ids)
    ? Array.from(new Set((body as BulkTrashBody).ids.filter((id) => typeof id === "string" && id.length > 0)))
    : [];

  if (ids.length === 0 || ids.length > MAX_BULK_IDS) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  const entriesToTrash = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId,
        id: { in: ids },
        deletedAt: null,
      },
      select: { id: true },
    }),
  );
  const entryIds = entriesToTrash.map((entry) => entry.id);

  const deletedAt = new Date();
  const result = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.updateMany({
      where: {
        teamId,
        id: { in: entryIds },
        deletedAt: null,
      },
      data: {
        deletedAt,
      },
    }),
  );
  const movedEntries = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId,
        id: { in: entryIds },
        deletedAt,
      },
      select: { id: true },
    }),
  );
  const movedEntryIds = movedEntries.map((entry) => entry.id);
  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_BULK_TRASH,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: {
      bulk: true,
      requestedCount: ids.length,
      movedCount: result.count,
      entryIds: movedEntryIds,
    },
    ...requestMeta,
  });

  for (const entryId of movedEntryIds) {
    logAudit({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_TRASH,
      userId: session.user.id,
      teamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-trash",
        parentAction: AUDIT_ACTION.ENTRY_BULK_TRASH,
      },
      ...requestMeta,
    });
  }

  return NextResponse.json({ success: true, movedCount: result.count });
}

export const POST = withRequestLog(handlePOST);
