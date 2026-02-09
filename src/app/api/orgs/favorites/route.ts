import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { unwrapOrgKey, decryptServerData } from "@/lib/crypto-server";
import { hasOrgPermission } from "@/lib/org-auth";

// GET /api/orgs/favorites — Get all org passwords favorited by current user
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Build role map for permission check + UI display
  const memberships = await prisma.orgMember.findMany({
    where: { userId: session.user.id },
    select: { orgId: true, role: true },
  });
  const roleMap = new Map(memberships.map((m) => [m.orgId, m.role]));

  const favorites = await prisma.orgPasswordFavorite.findMany({
    where: { userId: session.user.id },
    include: {
      orgPasswordEntry: {
        include: {
          org: {
            select: {
              id: true,
              name: true,
              encryptedOrgKey: true,
              orgKeyIv: true,
              orgKeyAuthTag: true,
            },
          },
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
    return role && hasOrgPermission(role, "password:read");
  });

  const entries = active.map((f) => {
    const entry = f.orgPasswordEntry;
    const orgKey = unwrapOrgKey({
      ciphertext: entry.org.encryptedOrgKey,
      iv: entry.org.orgKeyIv,
      authTag: entry.org.orgKeyAuthTag,
    });

    const overview = JSON.parse(
      decryptServerData(
        {
          ciphertext: entry.encryptedOverview,
          iv: entry.overviewIv,
          authTag: entry.overviewAuthTag,
        },
        orgKey
      )
    );

    return {
      id: entry.id,
      entryType: entry.entryType,
      orgId: entry.org.id,
      orgName: entry.org.name,
      role: roleMap.get(entry.orgId),
      title: overview.title,
      username: overview.username ?? null,
      urlHost: overview.urlHost ?? null,
      snippet: overview.snippet ?? null,
      brand: overview.brand ?? null,
      lastFour: overview.lastFour ?? null,
      cardholderName: overview.cardholderName ?? null,
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
