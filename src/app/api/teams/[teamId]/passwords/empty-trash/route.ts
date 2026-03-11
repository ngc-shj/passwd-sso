import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
  AUDIT_TARGET_TYPE,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string }> };

// POST /api/teams/[teamId]/passwords/empty-trash — Permanently delete all trashed entries
export async function POST(req: NextRequest, { params }: Params) {
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

  const entries = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId,
        deletedAt: { not: null },
      },
      select: { id: true },
    }),
  );
  const entryIds = entries.map((entry) => entry.id);

  const result = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.deleteMany({
      where: {
        teamId,
        id: { in: entryIds },
        deletedAt: { not: null },
      },
    }),
  );

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: "trash",
    metadata: {
      operation: "empty-trash",
      deletedCount: result.count,
      entryIds,
    },
    ...requestMeta,
  });

  for (const entryId of entryIds) {
    logAudit({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_PERMANENT_DELETE,
      userId: session.user.id,
      teamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "empty-trash",
        parentAction: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
      },
      ...requestMeta,
    });
  }

  return NextResponse.json({ success: true, deletedCount: result.count });
}
