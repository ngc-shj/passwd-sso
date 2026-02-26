import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hasTeamPermission } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

// GET /api/teams/favorites — Get all org passwords favorited by current user
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Build role map for permission check + UI display
  const memberships = await prisma.orgMember.findMany({
    where: { userId: session.user.id, deactivatedAt: null },
    select: { orgId: true, role: true },
  });
  const roleMap = new Map(memberships.map((m) => [m.orgId, m.role]));

  const favorites = await prisma.orgPasswordFavorite.findMany({
    where: { userId: session.user.id },
    include: {
      orgPasswordEntry: {
        include: {
          org: { select: { id: true, name: true } },
          tags: { select: { id: true, name: true, color: true } },
          createdBy: { select: { id: true, name: true, image: true } },
          updatedBy: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Filter out deleted/archived entries and entries user can no longer read
  const active = favorites.filter((f) => {
    const entry = f.orgPasswordEntry;
    if (entry.deletedAt || entry.isArchived) return false;
    const role = roleMap.get(entry.orgId);
    return role && hasTeamPermission(role, TEAM_PERMISSION.PASSWORD_READ);
  });

  const entries = active.map((f) => {
    const entry = f.orgPasswordEntry;
    return {
      id: entry.id,
      entryType: entry.entryType,
      orgId: entry.org.id,
      orgName: entry.org.name,
      role: roleMap.get(entry.orgId),
      encryptedOverview: entry.encryptedOverview,
      overviewIv: entry.overviewIv,
      overviewAuthTag: entry.overviewAuthTag,
      aadVersion: entry.aadVersion,
      orgKeyVersion: entry.orgKeyVersion,
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
