import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createE2EPasswordSchema } from "@/lib/validations";

// GET /api/passwords - List passwords (returns encrypted overviews)
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const tagId = searchParams.get("tag");
  const entryType = searchParams.get("type");
  const includeBlob = searchParams.get("include") === "blob";
  const favoritesOnly = searchParams.get("favorites") === "true";
  const trashOnly = searchParams.get("trash") === "true";
  const archivedOnly = searchParams.get("archived") === "true";

  const passwords = await prisma.passwordEntry.findMany({
    where: {
      userId: session.user.id,
      ...(trashOnly
        ? { deletedAt: { not: null } }
        : { deletedAt: null }),
      ...(archivedOnly
        ? { isArchived: true }
        : trashOnly ? {} : { isArchived: false }),
      ...(favoritesOnly ? { isFavorite: true } : {}),
      ...(tagId ? { tags: { some: { id: tagId } } } : {}),
      ...(entryType ? { entryType } : {}),
    },
    include: { tags: { select: { id: true } } },
    orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }],
  });

  // Auto-purge items deleted more than 30 days ago
  if (!trashOnly) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.passwordEntry.deleteMany({
      where: {
        userId: session.user.id,
        deletedAt: { lt: thirtyDaysAgo },
      },
    }).catch(() => {});
  }

  // Return encrypted overviews (and optionally blobs) for client-side decryption
  const entries = passwords.map((entry) => ({
    id: entry.id,
    encryptedOverview: {
      ciphertext: entry.encryptedOverview,
      iv: entry.overviewIv,
      authTag: entry.overviewAuthTag,
    },
    ...(includeBlob
      ? {
          encryptedBlob: {
            ciphertext: entry.encryptedBlob,
            iv: entry.blobIv,
            authTag: entry.blobAuthTag,
          },
        }
      : {}),
    keyVersion: entry.keyVersion,
    entryType: entry.entryType,
    isFavorite: entry.isFavorite,
    isArchived: entry.isArchived,
    tagIds: entry.tags.map((t) => t.id),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: entry.deletedAt,
  }));

  return NextResponse.json(entries);
}

// POST /api/passwords - Create new password entry (E2E encrypted)
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createE2EPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { encryptedBlob, encryptedOverview, keyVersion, tagIds, entryType } = parsed.data;

  const entry = await prisma.passwordEntry.create({
    data: {
      encryptedBlob: encryptedBlob.ciphertext,
      blobIv: encryptedBlob.iv,
      blobAuthTag: encryptedBlob.authTag,
      encryptedOverview: encryptedOverview.ciphertext,
      overviewIv: encryptedOverview.iv,
      overviewAuthTag: encryptedOverview.authTag,
      keyVersion,
      entryType,
      userId: session.user.id,
      ...(tagIds?.length
        ? { tags: { connect: tagIds.map((id) => ({ id })) } }
        : {}),
    },
    include: { tags: { select: { id: true } } },
  });

  return NextResponse.json(
    {
      id: entry.id,
      encryptedOverview: {
        ciphertext: entry.encryptedOverview,
        iv: entry.overviewIv,
        authTag: entry.overviewAuthTag,
      },
      keyVersion: entry.keyVersion,
      entryType: entry.entryType,
      tagIds: entry.tags.map((t) => t.id),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    { status: 201 }
  );
}
