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
import { bulkIdsSchema } from "@/lib/validations";

// POST /api/teams/[teamId]/passwords/bulk-trash - Soft delete multiple team entries (move to trash)
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

  const deletedAt = new Date();
  const [entryIds, updateResult] = await withTeamTenantRls(teamId, () =>
    prisma.$transaction(async (tx) => {
      const entries = await tx.teamPasswordEntry.findMany({
        where: {
          teamId,
          id: { in: ids },
          deletedAt: null,
        },
        select: { id: true },
      });
      const entryIds = entries.map((entry) => entry.id);
      const result = await tx.teamPasswordEntry.updateMany({
        where: {
          teamId,
          id: { in: entryIds },
          deletedAt: null,
        },
        data: { deletedAt },
      });
      return [entryIds, result] as const;
    }),
  );
  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_BULK_TRASH,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: null,
    metadata: {
      bulk: true,
      requestedCount: ids.length,
      movedCount: updateResult.count,
      entryIds,
    },
    ...requestMeta,
  });

  logAuditBatch(
    entryIds.map((entryId) => ({
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
    })),
  );

  return NextResponse.json({ success: true, movedCount: updateResult.count });
}

export const POST = withRequestLog(handlePOST);
