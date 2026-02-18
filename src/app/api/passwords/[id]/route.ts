import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateE2EPasswordSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { authOrToken } from "@/lib/auth-or-token";
import { withRequestLog } from "@/lib/with-request-log";
import { EXTENSION_TOKEN_SCOPE, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

// GET /api/passwords/[id] - Get password detail (returns encrypted blob)
async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authOrToken(req, EXTENSION_TOKEN_SCOPE.PASSWORDS_READ);
  if (authResult?.type === "scope_insufficient") {
    return NextResponse.json(
      { error: API_ERROR.EXTENSION_TOKEN_SCOPE_INSUFFICIENT },
      { status: 403 },
    );
  }
  if (!authResult) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  const userId = authResult.userId;

  const { id } = await params;

  const entry = await prisma.passwordEntry.findUnique({
    where: { id },
    include: { tags: { select: { id: true } } },
  });

  if (!entry) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (entry.userId !== userId) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
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
    requireReprompt: entry.requireReprompt,
    folderId: entry.folderId,
    tagIds: entry.tags.map((t) => t.id),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

// PUT /api/passwords/[id] - Update password entry (E2E encrypted)
async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.passwordEntry.findUnique({
    where: { id },
  });

  if (!existing) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = updateE2EPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, folderId, isFavorite, isArchived, entryType, requireReprompt } = parsed.data;
  const updateData: Record<string, unknown> = {};

  // If encryptedBlob is changing, snapshot the current version to history
  if (encryptedBlob) {
    await prisma.$transaction(async (tx) => {
      await tx.passwordEntryHistory.create({
        data: {
          entryId: id,
          encryptedBlob: existing.encryptedBlob,
          blobIv: existing.blobIv,
          blobAuthTag: existing.blobAuthTag,
          keyVersion: existing.keyVersion,
          aadVersion: existing.aadVersion,
        },
      });
      // Trim to max 20 entries (stable sort: changedAt asc, id asc)
      const all = await tx.passwordEntryHistory.findMany({
        where: { entryId: id },
        orderBy: [{ changedAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (all.length > 20) {
        await tx.passwordEntryHistory.deleteMany({
          where: { id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
        });
      }
    });

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
  if (folderId !== undefined) updateData.folderId = folderId;
  if (isFavorite !== undefined) updateData.isFavorite = isFavorite;
  if (isArchived !== undefined) updateData.isArchived = isArchived;
  if (entryType !== undefined) updateData.entryType = entryType;
  if (requireReprompt !== undefined) updateData.requireReprompt = requireReprompt;
  if (tagIds !== undefined) {
    updateData.tags = { set: tagIds.map((tid) => ({ id: tid })) };
  }

  const updated = await prisma.passwordEntry.update({
    where: { id },
    data: updateData,
    include: { tags: { select: { id: true } } },
  });

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_UPDATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
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
    requireReprompt: updated.requireReprompt,
    tagIds: updated.tags.map((t) => t.id),
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  });
}

// DELETE /api/passwords/[id] - Soft delete (move to trash)
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  const existing = await prisma.passwordEntry.findUnique({
    where: { id },
  });

  if (!existing) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
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
    scope: AUDIT_SCOPE.PERSONAL,
    action: permanent
      ? AUDIT_ACTION.ENTRY_PERMANENT_DELETE
      : AUDIT_ACTION.ENTRY_TRASH,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
    metadata: { permanent },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
