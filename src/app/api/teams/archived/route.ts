import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hasOrgPermission } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

// GET /api/teams/archived — Get all archived org passwords across all orgs
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Find all orgs the user is a member of (with role for permission check)
  const memberships = await prisma.orgMember.findMany({
    where: { userId: session.user.id, deactivatedAt: null },
    select: { orgId: true, role: true },
  });

  // Only include orgs where user has password:read permission
  const readable = memberships.filter((m) =>
    hasOrgPermission(m.role, TEAM_PERMISSION.PASSWORD_READ)
  );
  const orgIds = readable.map((m) => m.orgId);
  const roleMap = new Map(readable.map((m) => [m.orgId, m.role]));

  if (orgIds.length === 0) {
    return NextResponse.json([]);
  }

  // Find all archived (not trashed) org password entries
  const archivedEntries = await prisma.orgPasswordEntry.findMany({
    where: {
      orgId: { in: orgIds },
      isArchived: true,
      deletedAt: null,
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

  const entries = archivedEntries.map((entry) => ({
    id: entry.id,
    entryType: entry.entryType,
    orgId: entry.org.id,
    orgName: entry.org.name,
    role: roleMap.get(entry.orgId),
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
    orgKeyVersion: entry.orgKeyVersion,
  }));

  // Sort by updatedAt desc
  entries.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return NextResponse.json(entries);
}
