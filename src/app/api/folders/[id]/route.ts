import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { updateFolderSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, notFound, forbidden } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import {
  validateParentFolder,
  validateFolderDepth,
  checkCircularReference,
  type ParentNode,
} from "@/lib/folder/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";

function getPersonalParent(userId: string, id: string): Promise<ParentNode | null> {
  return withUserTenantRls(userId, async () =>
    prisma.folder
      .findUnique({ where: { id }, select: { parentId: true, userId: true } })
      .then((f) => (f ? { parentId: f.parentId, ownerId: f.userId } : null)),
  );
}

// PUT /api/folders/[id] - Update a folder
async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.findUnique({ where: { id } }),
  );
  if (!existing) {
    return notFound();
  }
  if (existing.userId !== session.user.id) {
    return forbidden();
  }

  const result = await parseBody(req, updateFolderSchema);
  if (!result.ok) return result.response;

  const { name, parentId, sortOrder } = result.data;
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
          return notFound();
        }

        // Cannot set parent to self
        if (newParentId === id) {
          return errorResponse(API_ERROR.FOLDER_CIRCULAR_REFERENCE, 400);
        }

        const isCircular = await checkCircularReference(
          id,
          newParentId,
          (parentId) => getPersonalParent(session.user.id, parentId),
        );
        if (isCircular) {
          return errorResponse(API_ERROR.FOLDER_CIRCULAR_REFERENCE, 400);
        }
      }

      try {
        await validateFolderDepth(
          newParentId,
          session.user.id,
          (parentId) => getPersonalParent(session.user.id, parentId),
        );
      } catch {
        return errorResponse(API_ERROR.FOLDER_MAX_DEPTH_EXCEEDED, 400);
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
        return errorResponse(API_ERROR.FOLDER_ALREADY_EXISTS, 409);
      }
    } else {
      const rootDup = await withUserTenantRls(session.user.id, async () =>
        prisma.folder.findFirst({
          where: { name: finalName, parentId: null, userId: session.user.id },
        }),
      );
      if (rootDup && rootDup.id !== id) {
        return errorResponse(API_ERROR.FOLDER_ALREADY_EXISTS, 409);
      }
    }
  }

  let folder;
  try {
    folder = await withUserTenantRls(session.user.id, async () =>
      prisma.folder.update({
        where: { id },
        data: updateData,
      }),
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return errorResponse(API_ERROR.FOLDER_ALREADY_EXISTS, 409);
    }
    throw err;
  }

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.FOLDER_UPDATE,
    targetType: AUDIT_TARGET_TYPE.FOLDER,
    targetId: id,
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
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.findUnique({ where: { id } }),
  );
  if (!existing) {
    return notFound();
  }
  if (existing.userId !== session.user.id) {
    return forbidden();
  }

  // Collect children and detect name conflicts at the target parent level.
  // The deleted folder still occupies a name slot during the transaction,
  // so we must include it when computing used names.
  await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction(async (tx) => {
      // Fetch children and siblings inside the transaction to avoid TOCTOU
      const children = await tx.folder.findMany({
        where: { parentId: id },
        select: { id: true, name: true },
      });

      const siblingsAtTarget = await tx.folder.findMany({
        where: { parentId: existing.parentId, userId: session.user.id },
        select: { id: true, name: true },
      });

      const usedNames = new Set(
        siblingsAtTarget
          .filter((s) => s.id !== id)
          .map((s) => s.name),
      );

      // Build rename map for children that would collide
      usedNames.add(existing.name);

      const renames = new Map<string, string>();
      for (const child of children) {
        if (usedNames.has(child.name)) {
          let suffix = 2;
          let newName = `${child.name} (${suffix})`;
          while (usedNames.has(newName)) {
            suffix++;
            newName = `${child.name} (${suffix})`;
          }
          renames.set(child.id, newName);
          usedNames.add(newName);
        } else {
          usedNames.add(child.name);
        }
      }

      // Promote children individually, renaming conflicts in the same update
      for (const child of children) {
        const newName = renames.get(child.id);
        await tx.folder.update({
          where: { id: child.id },
          data: {
            parentId: existing.parentId,
            ...(newName ? { name: newName } : {}),
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

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.FOLDER_DELETE,
    targetType: AUDIT_TARGET_TYPE.FOLDER,
    targetId: id,
  });

  return NextResponse.json({ success: true });
}

export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
