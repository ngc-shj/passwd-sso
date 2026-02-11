import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateE2EPasswordSchema } from "@/lib/validations";

// GET /api/passwords/[id] - Get password detail (returns encrypted blob)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const entry = await prisma.passwordEntry.findUnique({
    where: { id },
    include: { tags: { select: { id: true } } },
  });

  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (entry.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    id: entry.id,
    encryptedBlob: {
      ciphertext: entry.encryptedBlob,
      iv: entry.blobIv,
      authTag: entry.blobAuthTag,
    },
    encryptedOverview: {
      ciphertext: entry.encryptedOverview,
      iv: entry.overviewIv,
      authTag: entry.overviewAuthTag,
    },
    keyVersion: entry.keyVersion,
    aadVersion: entry.aadVersion,
    entryType: entry.entryType,
    isFavorite: entry.isFavorite,
    isArchived: entry.isArchived,
    tagIds: entry.tags.map((t) => t.id),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

// PUT /api/passwords/[id] - Update password entry (E2E encrypted)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.passwordEntry.findUnique({
    where: { id },
  });

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateE2EPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, isFavorite, isArchived, entryType } = parsed.data;
  const updateData: Record<string, unknown> = {};

  if (encryptedBlob) {
    updateData.encryptedBlob = encryptedBlob.ciphertext;
    updateData.blobIv = encryptedBlob.iv;
    updateData.blobAuthTag = encryptedBlob.authTag;
  }
  if (encryptedOverview) {
    updateData.encryptedOverview = encryptedOverview.ciphertext;
    updateData.overviewIv = encryptedOverview.iv;
    updateData.overviewAuthTag = encryptedOverview.authTag;
  }
  if (keyVersion !== undefined) updateData.keyVersion = keyVersion;
  if (aadVersion !== undefined) updateData.aadVersion = aadVersion;
  if (isFavorite !== undefined) updateData.isFavorite = isFavorite;
  if (isArchived !== undefined) updateData.isArchived = isArchived;
  if (entryType !== undefined) updateData.entryType = entryType;
  if (tagIds !== undefined) {
    updateData.tags = { set: tagIds.map((tid) => ({ id: tid })) };
  }

  const updated = await prisma.passwordEntry.update({
    where: { id },
    data: updateData,
    include: { tags: { select: { id: true } } },
  });

  logAudit({
    scope: "PERSONAL",
    action: "ENTRY_UPDATE",
    userId: session.user.id,
    targetType: "PasswordEntry",
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({
    id: updated.id,
    encryptedOverview: {
      ciphertext: updated.encryptedOverview,
      iv: updated.overviewIv,
      authTag: updated.overviewAuthTag,
    },
    keyVersion: updated.keyVersion,
    aadVersion: updated.aadVersion,
    entryType: updated.entryType,
    tagIds: updated.tags.map((t) => t.id),
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  });
}

// DELETE /api/passwords/[id] - Soft delete (move to trash)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  const existing = await prisma.passwordEntry.findUnique({
    where: { id },
  });

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (permanent) {
    await prisma.passwordEntry.delete({ where: { id } });
  } else {
    await prisma.passwordEntry.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  logAudit({
    scope: "PERSONAL",
    action: "ENTRY_DELETE",
    userId: session.user.id,
    targetType: "PasswordEntry",
    targetId: id,
    metadata: { permanent },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
