import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hasTeamPermission } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

// GET /api/teams/trash — Get all trashed team passwords across all teams
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Find all teams the user is a member of (with role for permission check)
  const memberships = await prisma.orgMember.findMany({
    where: { userId: session.user.id, deactivatedAt: null },
    select: { orgId: true, role: true },
  });

  // Only include teams where user has password:read permission
  const readable = memberships.filter((m) =>
    hasTeamPermission(m.role, TEAM_PERMISSION.PASSWORD_READ)
  );
  const teamIds = readable.map((m) => m.orgId);
  const roleMap = new Map(readable.map((m) => [m.orgId, m.role]));

  if (teamIds.length === 0) {
    return NextResponse.json([]);
  }

  // Find all trashed team password entries (deletedAt is set)
  const trashedEntries = await prisma.orgPasswordEntry.findMany({
    where: {
      orgId: { in: teamIds },
      deletedAt: { not: null },
    },
    include: {
      org: {
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
  });

  const entries = trashedEntries.map((entry) => ({
    id: entry.id,
    entryType: entry.entryType,
    teamId: entry.org.id,
    teamName: entry.org.name,
    role: roleMap.get(entry.orgId),
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    deletedAt: entry.deletedAt,
    tags: entry.tags,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    encryptedOverview: entry.encryptedOverview,
    overviewIv: entry.overviewIv,
    overviewAuthTag: entry.overviewAuthTag,
    aadVersion: entry.aadVersion,
    orgKeyVersion: entry.orgKeyVersion,
  }));

  // Sort by deletedAt desc (most recently trashed first)
  entries.sort(
    (a, b) =>
      new Date(b.deletedAt!).getTime() - new Date(a.deletedAt!).getTime()
  );

  return NextResponse.json(entries);
}
