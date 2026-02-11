import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { unwrapOrgKey, decryptServerData } from "@/lib/crypto-server";
import { buildOrgEntryAAD } from "@/lib/crypto-aad";
import { hasOrgPermission } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";

// GET /api/orgs/trash — Get all trashed org passwords across all orgs
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Find all orgs the user is a member of (with role for permission check)
  const memberships = await prisma.orgMember.findMany({
    where: { userId: session.user.id },
    select: { orgId: true, role: true },
  });

  // Only include orgs where user has password:read permission
  const readable = memberships.filter((m) =>
    hasOrgPermission(m.role, "password:read")
  );
  const orgIds = readable.map((m) => m.orgId);
  const roleMap = new Map(readable.map((m) => [m.orgId, m.role]));

  if (orgIds.length === 0) {
    return NextResponse.json([]);
  }

  // Find all trashed org password entries (deletedAt is set)
  const trashedEntries = await prisma.orgPasswordEntry.findMany({
    where: {
      orgId: { in: orgIds },
      deletedAt: { not: null },
    },
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
      favorites: {
        where: { userId: session.user.id },
        select: { id: true },
      },
    },
  });

  const entries = trashedEntries.map((entry) => {
    const orgKey = unwrapOrgKey({
      ciphertext: entry.org.encryptedOrgKey,
      iv: entry.org.orgKeyIv,
      authTag: entry.org.orgKeyAuthTag,
    });

    const aad = entry.aadVersion >= 1
      ? Buffer.from(buildOrgEntryAAD(entry.orgId, entry.id, "overview"))
      : undefined;
    const overview = JSON.parse(
      decryptServerData(
        {
          ciphertext: entry.encryptedOverview,
          iv: entry.overviewIv,
          authTag: entry.overviewAuthTag,
        },
        orgKey,
        aad
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
      fullName: overview.fullName ?? null,
      idNumberLast4: overview.idNumberLast4 ?? null,
      isFavorite: entry.favorites.length > 0,
      isArchived: entry.isArchived,
      deletedAt: entry.deletedAt,
      tags: entry.tags,
      createdBy: entry.createdBy,
      updatedBy: entry.updatedBy,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  });

  // Sort by deletedAt desc (most recently trashed first)
  entries.sort(
    (a, b) =>
      new Date(b.deletedAt!).getTime() - new Date(a.deletedAt!).getTime()
  );

  return NextResponse.json(entries);
}
