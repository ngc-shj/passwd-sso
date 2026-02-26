import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";

type Params = { params: Promise<{ teamId: string; id: string }> };

// GET /api/teams/[teamId]/passwords/[id]/history - List team entry history
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await requireTeamMember(session.user.id, teamId);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.teamPasswordEntry.findUnique({
    where: { id },
    select: { teamId: true },
  });

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const histories = await prisma.teamPasswordEntryHistory.findMany({
    where: { entryId: id },
    orderBy: { changedAt: "desc" },
    include: { changedBy: { select: { id: true, name: true, email: true } } },
  });

  return NextResponse.json(
    histories.map((h) => ({
      id: h.id,
      entryId: h.entryId,
      encryptedBlob: {
        ciphertext: h.encryptedBlob,
        iv: h.blobIv,
        authTag: h.blobAuthTag,
      },
      aadVersion: h.aadVersion,
      teamKeyVersion: h.teamKeyVersion,
      changedAt: h.changedAt,
      changedBy: h.changedBy,
    })),
  );
}
