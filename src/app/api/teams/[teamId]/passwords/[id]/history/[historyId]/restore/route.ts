import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION, AUDIT_METADATA_KEY, TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

// POST /api/teams/[teamId]/passwords/[id]/history/[historyId]/restore
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, historyId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_UPDATE, req);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: {
        teamId: true,
        tenantId: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        aadVersion: true,
        teamKeyVersion: true,
      },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const history = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntryHistory.findUnique({
      where: { id: historyId },
      select: {
        entryId: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        aadVersion: true,
        teamKeyVersion: true,
        changedAt: true,
      },
    }),
  );

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND, 404);
  }

  await withTeamTenantRls(teamId, async () =>
    prisma.$transaction(async (tx) => {
    // Snapshot current
    await tx.teamPasswordEntryHistory.create({
      data: {
        entryId: id,
        tenantId: entry.tenantId,
        encryptedBlob: entry.encryptedBlob,
        blobIv: entry.blobIv,
        blobAuthTag: entry.blobAuthTag,
        aadVersion: entry.aadVersion,
        teamKeyVersion: entry.teamKeyVersion,
        changedById: session.user.id,
      },
    });

    // Trim to max 20
    const all = await tx.teamPasswordEntryHistory.findMany({
      where: { entryId: id },
      orderBy: [{ changedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (all.length > 20) {
      await tx.teamPasswordEntryHistory.deleteMany({
        where: { id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
      });
    }

    // Restore: writes back history blob with its original teamKeyVersion.
    // If history.teamKeyVersion !== team.teamKeyVersion (e.g. after key rotation),
    // the client must detect the mismatch, decrypt with the old key via
    // GET /member-key?keyVersion=N, re-encrypt with the current key, and PUT.
    await tx.teamPasswordEntry.update({
      where: { id },
      data: {
        encryptedBlob: history.encryptedBlob,
        blobIv: history.blobIv,
        blobAuthTag: history.blobAuthTag,
        aadVersion: history.aadVersion,
        teamKeyVersion: history.teamKeyVersion,
        updatedById: session.user.id,
      },
    });
    }),
  );

  await logAuditAsync({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_HISTORY_RESTORE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      [AUDIT_METADATA_KEY.HISTORY_ID]: historyId,
      [AUDIT_METADATA_KEY.RESTORED_FROM_CHANGED_AT]: history.changedAt.toISOString(),
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
