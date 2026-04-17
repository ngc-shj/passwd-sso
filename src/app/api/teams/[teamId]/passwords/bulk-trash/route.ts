import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission } from "@/lib/team-auth";
import { withRequestLog } from "@/lib/with-request-log";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";
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
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE, req);
  } catch (e) {
    return handleAuthError(e);
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

  await logAuditAsync({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_BULK_TRASH,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    // targetId omitted for bulk operations
    metadata: {
      bulk: true,
      requestedCount: ids.length,
      movedCount: updateResult.count,
      entryIds,
    },
    ...requestMeta,
  });

  const auditEntries = entryIds.map((entryId) => ({
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
  }));
  for (const entry of auditEntries) {
    await logAuditAsync(entry);
  }

  return NextResponse.json({ success: true, movedCount: updateResult.count });
}

export const POST = withRequestLog(handlePOST);
