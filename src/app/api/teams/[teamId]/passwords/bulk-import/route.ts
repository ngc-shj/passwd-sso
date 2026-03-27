import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAudit, logAuditBatch, extractRequestMeta } from "@/lib/audit";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { unauthorized } from "@/lib/api-response";
import { rateLimited } from "@/lib/api-response";
import { errorResponse } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { bulkTeamImportSchema } from "@/lib/validations";
import { createRateLimiter } from "@/lib/rate-limit";
import { FILENAME_MAX_LENGTH } from "@/lib/validations/common";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import * as teamPasswordService from "@/lib/services/team-password-service";

type Params = { params: Promise<{ teamId: string }> };

const teamBulkImportLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

// POST /api/teams/[teamId]/passwords/bulk-import - Bulk create team password entries (E2E encrypted)
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const { teamId } = await params;

  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.PASSWORD_CREATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const rl = await teamBulkImportLimiter.check(`rl:team_bulk_import:${teamId}:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, bulkTeamImportSchema);
  if (!result.ok) return result.response;

  const { entries, sourceFilename } = result.data;

  const sanitizedFilename = sourceFilename
    ? sourceFilename
        .replace(/[\0\x01-\x1f\x7f-\x9f]/g, "")
        .replace(/[/\\]/g, "_")
        .trim()
        .slice(0, FILENAME_MAX_LENGTH) || undefined
    : undefined;

  const createdIds: string[] = [];
  let failedCount = 0;

  await withTeamTenantRls(teamId, async () => {
    for (const entryData of entries) {
      try {
        const entry = await teamPasswordService.createTeamPassword(teamId, {
          id: entryData.id,
          encryptedBlob: entryData.encryptedBlob,
          encryptedOverview: entryData.encryptedOverview,
          aadVersion: entryData.aadVersion,
          teamKeyVersion: entryData.teamKeyVersion,
          itemKeyVersion: entryData.itemKeyVersion,
          encryptedItemKey: entryData.encryptedItemKey,
          entryType: entryData.entryType,
          userId,
          tagIds: entryData.tagIds,
          teamFolderId: entryData.teamFolderId,
          requireReprompt: entryData.requireReprompt,
          expiresAt: entryData.expiresAt,
        });

        createdIds.push(entry.id);
      } catch {
        failedCount++;
      }
    }
  });

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_BULK_IMPORT,
    userId,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    // targetId omitted for bulk operations
    metadata: {
      bulk: true,
      requestedCount: entries.length,
      createdCount: createdIds.length,
      failedCount,
      ...(sanitizedFilename ? { filename: sanitizedFilename } : {}),
    },
    ...requestMeta,
  });

  logAuditBatch(
    createdIds.map((entryId) => ({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId,
      teamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-import",
        parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT,
      },
      ...requestMeta,
    })),
  );

  return NextResponse.json(
    { success: createdIds.length, failed: failedCount },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
