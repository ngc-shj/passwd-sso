import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hasTeamPermission } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withBypassRls } from "@/lib/tenant-rls";

// GET /api/teams/archived — Get all archived team passwords across all teams
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Find all teams the user is a member of (with role for permission check)
  const memberships = await withBypassRls(prisma, async () =>
    prisma.teamMember.findMany({
      where: { userId: session.user.id, deactivatedAt: null },
      select: { teamId: true, role: true },
    }),
  );

  // Only include teams where user has password:read permission
  const readable = memberships.filter((m) =>
    hasTeamPermission(m.role, TEAM_PERMISSION.PASSWORD_READ)
  );
  const teamIds = readable.map((m) => m.teamId);
  const roleMap = new Map(readable.map((m) => [m.teamId, m.role]));

  if (teamIds.length === 0) {
    return NextResponse.json([]);
  }

  // Find all archived (not trashed) team password entries
  const archivedEntries = await withBypassRls(prisma, async () =>
    prisma.teamPasswordEntry.findMany({
      where: {
        teamId: { in: teamIds },
        isArchived: true,
        deletedAt: null,
      },
      include: {
        team: {
          select: {
            id: true,
            name: true,
          },
        },
        tags: { select: { id: true, name: true, color: true } },
        createdBy: { select: { id: true, name: true, image: true } },
        updatedBy: { select: { id: true, name: true } },
        favorites: {
          where: { userId: session.user.id },
          select: { id: true },
        },
      },
    }),
  );

  const entries = archivedEntries.map((entry) => ({
    id: entry.id,
    entryType: entry.entryType,
    teamId: entry.team.id,
    teamName: entry.team.name,
    role: roleMap.get(entry.teamId),
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    tags: entry.tags,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    encryptedOverview: entry.encryptedOverview,
    overviewIv: entry.overviewIv,
    overviewAuthTag: entry.overviewAuthTag,
    aadVersion: entry.aadVersion,
    teamKeyVersion: entry.teamKeyVersion,
  }));

  // Sort by updatedAt desc
  entries.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return NextResponse.json(entries);
}
