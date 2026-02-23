import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateOrgE2EPasswordSchema } from "@/lib/validations";
import {
  requireOrgPermission,
  requireOrgMember,
  hasOrgPermission,
  OrgAuthError,
} from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION, ORG_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string; id: string }> };

// GET /api/orgs/[orgId]/passwords/[id] — Get password detail (encrypted blob, client decrypts)
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    include: {
      tags: { select: { id: true, name: true, color: true } },
      createdBy: { select: { id: true, name: true, image: true } },
      updatedBy: { select: { id: true, name: true } },
      favorites: {
        where: { userId: session.user.id },
        select: { id: true },
      },
    },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  return NextResponse.json({
    id: entry.id,
    entryType: entry.entryType,
    isFavorite: entry.favorites.length > 0,
    isArchived: entry.isArchived,
    orgFolderId: entry.orgFolderId,
    tags: entry.tags,
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    encryptedBlob: entry.encryptedBlob,
    blobIv: entry.blobIv,
    blobAuthTag: entry.blobAuthTag,
    encryptedOverview: entry.encryptedOverview,
    overviewIv: entry.overviewIv,
    overviewAuthTag: entry.overviewAuthTag,
    aadVersion: entry.aadVersion,
    orgKeyVersion: entry.orgKeyVersion,
  });
}

// PUT /api/orgs/[orgId]/passwords/[id] — Update password (E2E: full blob replacement)
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

  let membership;
  try {
    membership = await requireOrgMember(session.user.id, orgId);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    select: {
      orgId: true,
      createdById: true,
      encryptedBlob: true,
      blobIv: true,
      blobAuthTag: true,
      aadVersion: true,
      orgKeyVersion: true,
    },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // MEMBER can only update their own entries
  if (!hasOrgPermission(membership.role, ORG_PERMISSION.PASSWORD_UPDATE)) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }
  if (
    membership.role === ORG_ROLE.MEMBER &&
    entry.createdById !== session.user.id
  ) {
    return NextResponse.json(
      { error: API_ERROR.ONLY_OWN_ENTRIES },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = updateOrgE2EPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { encryptedBlob, encryptedOverview, aadVersion, orgKeyVersion, tagIds, orgFolderId, isArchived } = parsed.data;
  const isFullUpdate = encryptedBlob !== undefined;

  // Validate orgFolderId belongs to this org
  if (orgFolderId) {
    const folder = await prisma.orgFolder.findUnique({
      where: { id: orgFolderId },
      select: { orgId: true },
    });
    if (!folder || folder.orgId !== orgId) {
      return NextResponse.json({ error: API_ERROR.FOLDER_NOT_FOUND }, { status: 400 });
    }
  }

  const updateData: Record<string, unknown> = {
    updatedById: session.user.id,
  };

  if (isFullUpdate) {
    updateData.encryptedBlob = encryptedBlob!.ciphertext;
    updateData.blobIv = encryptedBlob!.iv;
    updateData.blobAuthTag = encryptedBlob!.authTag;
    updateData.encryptedOverview = encryptedOverview!.ciphertext;
    updateData.overviewIv = encryptedOverview!.iv;
    updateData.overviewAuthTag = encryptedOverview!.authTag;
    updateData.aadVersion = aadVersion;
    updateData.orgKeyVersion = orgKeyVersion;
  }

  if (orgFolderId !== undefined) updateData.orgFolderId = orgFolderId;
  if (isArchived !== undefined) updateData.isArchived = isArchived;
  if (tagIds !== undefined) {
    updateData.tags = { set: tagIds.map((tid) => ({ id: tid })) };
  }

  // Snapshot current blob to history before updating (only for full updates)
  if (isFullUpdate) {
    await prisma.$transaction(async (tx) => {
      await tx.orgPasswordEntryHistory.create({
        data: {
          entryId: id,
          encryptedBlob: entry.encryptedBlob,
          blobIv: entry.blobIv,
          blobAuthTag: entry.blobAuthTag,
          aadVersion: entry.aadVersion,
          orgKeyVersion: entry.orgKeyVersion,
          changedById: session.user.id,
        },
      });
      const all = await tx.orgPasswordEntryHistory.findMany({
        where: { entryId: id },
        orderBy: [{ changedAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (all.length > 20) {
        await tx.orgPasswordEntryHistory.deleteMany({
          where: { id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
        });
      }
    });
  }

  const updated = await prisma.orgPasswordEntry.update({
    where: { id },
    data: updateData,
    include: {
      tags: { select: { id: true, name: true, color: true } },
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.ENTRY_UPDATE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_PASSWORD_ENTRY,
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({
    id: updated.id,
    entryType: updated.entryType,
    tags: updated.tags,
    updatedAt: updated.updatedAt,
  });
}

// DELETE /api/orgs/[orgId]/passwords/[id] — Soft delete (move to trash)
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.PASSWORD_DELETE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await prisma.orgPasswordEntry.findUnique({
    where: { id },
  });

  if (!existing || existing.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const permanent = searchParams.get("permanent") === "true";

  if (permanent) {
    await prisma.orgPasswordEntry.delete({ where: { id } });
  } else {
    await prisma.orgPasswordEntry.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.ENTRY_DELETE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_PASSWORD_ENTRY,
    targetId: id,
    metadata: { permanent },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
