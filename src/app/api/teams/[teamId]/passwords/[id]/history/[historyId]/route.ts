import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember } from "@/lib/auth/access/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

// GET /api/teams/[teamId]/passwords/[id]/history/[historyId] — Return encrypted history blob (client decrypts)
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, historyId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const [entry, history] = await withTeamTenantRls(teamId, () =>
    Promise.all([
      prisma.teamPasswordEntry.findUnique({
        where: { id },
        select: { teamId: true, entryType: true },
      }),
      prisma.teamPasswordEntryHistory.findUnique({
        where: { id: historyId },
      }),
    ]),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND);
  }

  return NextResponse.json({
    id: history.id,
    entryId: history.entryId,
    changedAt: history.changedAt,
    entryType: entry.entryType,
    encryptedBlob: history.encryptedBlob,
    blobIv: history.blobIv,
    blobAuthTag: history.blobAuthTag,
    aadVersion: history.aadVersion,
    teamKeyVersion: history.teamKeyVersion,
    itemKeyVersion: history.itemKeyVersion,
    encryptedItemKey: history.encryptedItemKey,
    itemKeyIv: history.itemKeyIv,
    itemKeyAuthTag: history.itemKeyAuthTag,
  });
}

export const GET = withRequestLog(handleGET);
