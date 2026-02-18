import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateFolderSchema } from "@/lib/validations";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  validateParentFolder,
  validateFolderDepth,
  checkCircularReference,
  type ParentNode,
} from "@/lib/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION, ORG_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string; id: string }> };

function getOrgParent(id: string): Promise<ParentNode | null> {
  return prisma.orgFolder
    .findUnique({ where: { id }, select: { parentId: true, orgId: true } })
    .then((f) => (f ? { parentId: f.parentId, ownerId: f.orgId } : null));
}

// PUT /api/orgs/[orgId]/folders/[id] - Update an org folder
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await prisma.orgFolder.findUnique({ where: { id } });
  if (!existing || existing.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
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

  if (parentId !== undefined) {
    const newParentId = parentId ?? null;

    if (newParentId !== existing.parentId) {
      if (newParentId) {
        // Parent ownership + existence check
        try {
          await validateParentFolder(newParentId, orgId, getOrgParent);
        } catch {
          return NextResponse.json(
            { error: API_ERROR.NOT_FOUND },
            { status: 404 },
          );
        }

        if (newParentId === id) {
          return NextResponse.json(
            { error: API_ERROR.FOLDER_CIRCULAR_REFERENCE },
            { status: 400 },
          );
        }

        const isCircular = await checkCircularReference(id, newParentId, getOrgParent);
        if (isCircular) {
          return NextResponse.json(
            { error: API_ERROR.FOLDER_CIRCULAR_REFERENCE },
            { status: 400 },
          );
        }
      }

      try {
        await validateFolderDepth(newParentId, orgId, getOrgParent);
      } catch {
        return NextResponse.json(
          { error: API_ERROR.FOLDER_MAX_DEPTH_EXCEEDED },
          { status: 400 },
        );
      }

      updateData.parentId = newParentId;
    }
  }

  const finalName = (updateData.name as string) ?? existing.name;
  const finalParentId =
    updateData.parentId !== undefined
      ? (updateData.parentId as string | null)
      : existing.parentId;

  if (finalName !== existing.name || finalParentId !== existing.parentId) {
    if (finalParentId) {
      const dup = await prisma.orgFolder.findUnique({
        where: { name_parentId_orgId: { name: finalName, parentId: finalParentId, orgId } },
      });
      if (dup && dup.id !== id) {
        return NextResponse.json(
          { error: API_ERROR.FOLDER_ALREADY_EXISTS },
          { status: 409 },
        );
      }
    } else {
      const rootDup = await prisma.orgFolder.findFirst({
        where: { name: finalName, parentId: null, orgId },
      });
      if (rootDup && rootDup.id !== id) {
        return NextResponse.json(
          { error: API_ERROR.FOLDER_ALREADY_EXISTS },
          { status: 409 },
        );
      }
    }
  }

  const folder = await prisma.orgFolder.update({
    where: { id },
    data: updateData,
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.FOLDER_UPDATE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_FOLDER,
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

// DELETE /api/orgs/[orgId]/folders/[id] - Delete an org folder
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await prisma.orgFolder.findUnique({ where: { id } });
  if (!existing || existing.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Collect children and detect name conflicts at the target parent level.
  const children = await prisma.orgFolder.findMany({
    where: { parentId: id },
    select: { id: true, name: true },
  });

  const siblingsAtTarget = await prisma.orgFolder.findMany({
    where: { parentId: existing.parentId, orgId },
    select: { id: true, name: true },
  });

  const usedNames = new Set(
    siblingsAtTarget
      .filter((s) => s.id !== id)
      .map((s) => s.name),
  );

  // Include the deleted folder's name (it still exists during the transaction)
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

  await prisma.$transaction(async (tx) => {
    for (const child of children) {
      const rename = renames.find((r) => r.childId === child.id);
      await tx.orgFolder.update({
        where: { id: child.id },
        data: {
          parentId: existing.parentId,
          ...(rename ? { name: rename.newName } : {}),
        },
      });
    }
    await tx.orgPasswordEntry.updateMany({
      where: { orgFolderId: id },
      data: { orgFolderId: null },
    });
    await tx.orgFolder.delete({ where: { id } });
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.FOLDER_DELETE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_FOLDER,
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
