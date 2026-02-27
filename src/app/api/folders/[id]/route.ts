import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateFolderSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  validateParentFolder,
  validateFolderDepth,
  checkCircularReference,
  type ParentNode,
} from "@/lib/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

function getPersonalParent(userId: string, id: string): Promise<ParentNode | null> {
  return withUserTenantRls(userId, async () =>
    prisma.folder
      .findUnique({ where: { id }, select: { parentId: true, userId: true } })
      .then((f) => (f ? { parentId: f.parentId, ownerId: f.userId } : null)),
  );
}

// PUT /api/folders/[id] - Update a folder
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.findUnique({ where: { id } }),
  );
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

  const parsed = updateFolderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { name, parentId, sortOrder } = parsed.data;
  const updateData: Record<string, unknown> = {};

  if (name !== undefined) updateData.name = name;
  if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

  // parentId change: check circular reference + depth
  if (parentId !== undefined) {
    const newParentId = parentId ?? null;

    if (newParentId !== existing.parentId) {
      if (newParentId) {
        // Parent ownership + existence check
        try {
          await validateParentFolder(
            newParentId,
            session.user.id,
            (parentId) => getPersonalParent(session.user.id, parentId),
          );
        } catch {
          return NextResponse.json(
            { error: API_ERROR.NOT_FOUND },
            { status: 404 },
          );
        }

        // Cannot set parent to self
        if (newParentId === id) {
          return NextResponse.json(
            { error: API_ERROR.FOLDER_CIRCULAR_REFERENCE },
            { status: 400 },
          );
        }

        const isCircular = await checkCircularReference(
          id,
          newParentId,
          (parentId) => getPersonalParent(session.user.id, parentId),
        );
        if (isCircular) {
          return NextResponse.json(
            { error: API_ERROR.FOLDER_CIRCULAR_REFERENCE },
            { status: 400 },
          );
        }
      }

      try {
        await validateFolderDepth(
          newParentId,
          session.user.id,
          (parentId) => getPersonalParent(session.user.id, parentId),
        );
      } catch {
        return NextResponse.json(
          { error: API_ERROR.FOLDER_MAX_DEPTH_EXCEEDED },
          { status: 400 },
        );
      }

      updateData.parentId = newParentId;
    }
  }

  // Duplicate name check
  const finalName = (updateData.name as string) ?? existing.name;
  const finalParentId =
    updateData.parentId !== undefined
      ? (updateData.parentId as string | null)
      : existing.parentId;

  if (finalName !== existing.name || finalParentId !== existing.parentId) {
    if (finalParentId) {
      const dup = await withUserTenantRls(session.user.id, async () =>
        prisma.folder.findUnique({
          where: {
            name_parentId_userId: {
              name: finalName,
              parentId: finalParentId,
              userId: session.user.id,
            },
          },
        }),
      );
      if (dup && dup.id !== id) {
        return NextResponse.json(
          { error: API_ERROR.FOLDER_ALREADY_EXISTS },
          { status: 409 },
        );
      }
    } else {
      const rootDup = await withUserTenantRls(session.user.id, async () =>
        prisma.folder.findFirst({
          where: { name: finalName, parentId: null, userId: session.user.id },
        }),
      );
      if (rootDup && rootDup.id !== id) {
        return NextResponse.json(
          { error: API_ERROR.FOLDER_ALREADY_EXISTS },
          { status: 409 },
        );
      }
    }
  }

  const folder = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.update({
      where: { id },
      data: updateData,
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.FOLDER_UPDATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.FOLDER,
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    sortOrder: folder.sortOrder,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  });
}

// DELETE /api/folders/[id] - Delete a folder (children promote to parent)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.findUnique({ where: { id } }),
  );
  if (!existing) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  // Collect children and detect name conflicts at the target parent level.
  // The deleted folder still occupies a name slot during the transaction,
  // so we must include it when computing used names.
  const children = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.findMany({
      where: { parentId: id },
      select: { id: true, name: true },
    }),
  );

  const siblingsAtTarget = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.findMany({
      where: { parentId: existing.parentId, userId: session.user.id },
      select: { id: true, name: true },
    }),
  );

  const usedNames = new Set(
    siblingsAtTarget
      .filter((s) => s.id !== id) // exclude the folder being deleted
      .map((s) => s.name),
  );

  // Build rename map for children that would collide (including with the
  // deleted folder's own name, which still exists during the transaction).
  // Also account for children colliding among themselves after adding the
  // deleted folder's name to usedNames.
  usedNames.add(existing.name);

  const renames: Array<{ childId: string; newName: string }> = [];
  for (const child of children) {
    if (usedNames.has(child.name)) {
      let suffix = 2;
      let newName = `${child.name} (${suffix})`;
      while (usedNames.has(newName)) {
        suffix++;
        newName = `${child.name} (${suffix})`;
      }
      renames.push({ childId: child.id, newName });
      usedNames.add(newName);
    } else {
      usedNames.add(child.name);
    }
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction(async (tx) => {
      // Promote children individually, renaming conflicts in the same update
      for (const child of children) {
        const rename = renames.find((r) => r.childId === child.id);
        await tx.folder.update({
          where: { id: child.id },
          data: {
            parentId: existing.parentId,
            ...(rename ? { name: rename.newName } : {}),
          },
        });
      }
      // Unassign entries from this folder
      await tx.passwordEntry.updateMany({
        where: { folderId: id },
        data: { folderId: null },
      });
      // Delete the folder
      await tx.folder.delete({ where: { id } });
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.FOLDER_DELETE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.FOLDER,
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
