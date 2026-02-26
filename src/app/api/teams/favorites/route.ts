import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hasTeamPermission } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

// GET /api/teams/favorites — Get all team passwords favorited by current user
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Build role map for permission check + UI display
  const memberships = await prisma.teamMember.findMany({
    where: { userId: session.user.id, deactivatedAt: null },
    select: { teamId: true, role: true },
  });
  const roleMap = new Map(memberships.map((m) => [m.teamId, m.role]));

  const favorites = await prisma.teamPasswordFavorite.findMany({
    where: { userId: session.user.id },
    include: {
      teamPasswordEntry: {
        include: {
          team: { select: { id: true, name: true } },
          tags: { select: { id: true, name: true, color: true } },
          createdBy: { select: { id: true, name: true, image: true } },
          updatedBy: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Filter out deleted/archived entries and entries user can no longer read
  const active = favorites.filter((f) => {
    const entry = f.teamPasswordEntry;
    if (entry.deletedAt || entry.isArchived) return false;
    const role = roleMap.get(entry.teamId);
    return role && hasTeamPermission(role, TEAM_PERMISSION.PASSWORD_READ);
  });

  const entries = active.map((f) => {
    const entry = f.teamPasswordEntry;
    return {
      id: entry.id,
      entryType: entry.entryType,
      teamId: entry.team.id,
      teamName: entry.team.name,
      role: roleMap.get(entry.teamId),
      encryptedOverview: entry.encryptedOverview,
      overviewIv: entry.overviewIv,
      overviewAuthTag: entry.overviewAuthTag,
      aadVersion: entry.aadVersion,
      teamKeyVersion: entry.teamKeyVersion,
      isFavorite: true,
      isArchived: entry.isArchived,
      tags: entry.tags,
      createdBy: entry.createdBy,
      updatedBy: entry.updatedBy,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  });

  // Sort by updatedAt desc
  entries.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return NextResponse.json(entries);
}
