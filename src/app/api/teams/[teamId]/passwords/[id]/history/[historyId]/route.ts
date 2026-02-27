import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { withUserTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

// GET /api/teams/[teamId]/passwords/[id]/history/[historyId] — Return encrypted history blob (client decrypts)
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id, historyId } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamMember(session.user.id, teamId),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true, entryType: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const history = await withUserTenantRls(session.user.id, async () =>
    prisma.teamPasswordEntryHistory.findUnique({
      where: { id: historyId },
    }),
  );

  if (!history || history.entryId !== id) {
    return NextResponse.json({ error: API_ERROR.HISTORY_NOT_FOUND }, { status: 404 });
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
  });
}
