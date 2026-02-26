import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string; id: string }> };

// POST /api/teams/[teamId]/passwords/[id]/favorite — Toggle per-user favorite
export async function POST(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Verify the password belongs to this team
  const entry = await prisma.teamPasswordEntry.findUnique({
    where: { id },
    select: { teamId: true },
  });

  if (!entry || entry.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Toggle: if exists, remove; if not, create
  const existing = await prisma.teamPasswordFavorite.findUnique({
    where: {
      userId_teamPasswordEntryId: {
        userId: session.user.id,
        teamPasswordEntryId: id,
      },
    },
  });

  if (existing) {
    await prisma.teamPasswordFavorite.delete({
      where: { id: existing.id },
    });
    return NextResponse.json({ isFavorite: false });
  } else {
    await prisma.teamPasswordFavorite.create({
      data: {
        userId: session.user.id,
        teamPasswordEntryId: id,
      },
    });
    return NextResponse.json({ isFavorite: true });
  }
}
