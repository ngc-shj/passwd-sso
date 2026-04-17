import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/team-auth";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
  AUDIT_TARGET_TYPE,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string }> };

// POST /api/teams/[teamId]/passwords/empty-trash — Permanently delete all trashed entries
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

  // Atomic findMany + deleteMany to prevent TOCTOU race
  const { entryIds, deletedCount } = await withTeamTenantRls(teamId, async (): Promise<{ entryIds: string[]; deletedCount: number }> => {
    const [entries, result] = await prisma.$transaction(async (tx) => {
      const found = await tx.teamPasswordEntry.findMany({
        where: { teamId, deletedAt: { not: null } },
        select: { id: true },
      });
      const ids = found.map((e) => e.id);
      const deleted = await tx.teamPasswordEntry.deleteMany({
        where: { teamId, id: { in: ids }, deletedAt: { not: null } },
      });
      return [found, deleted] as const;
    });
    return { entryIds: entries.map((e) => e.id), deletedCount: result.count };
  });

  const requestMeta = extractRequestMeta(req);

  await logAuditAsync({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: "trash",
    metadata: {
      operation: "empty-trash",
      deletedCount: deletedCount,
      entryIds,
    },
    ...requestMeta,
  });

  for (const entryId of entryIds) {
    await logAuditAsync({
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

  return NextResponse.json({ success: true, deletedCount: deletedCount });
}

export const POST = withRequestLog(handlePOST);
