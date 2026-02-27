import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateFolderSchema } from "@/lib/validations";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  validateParentFolder,
  validateFolderDepth,
  checkCircularReference,
  type ParentNode,
} from "@/lib/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION, TEAM_PERMISSION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string; id: string }> };

function getTeamParent(userId: string, id: string): Promise<ParentNode | null> {
  return withUserTenantRls(userId, async () =>
    prisma.teamFolder
      .findUnique({ where: { id }, select: { parentId: true, teamId: true } })
      .then((f) => (f ? { parentId: f.parentId, ownerId: f.teamId } : null)),
  );
}

// PUT /api/teams/[teamId]/folders/[id] - Update a team folder
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.teamFolder.findUnique({ where: { id } }),
  );
  if (!existing || existing.teamId !== teamId) {
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
          await validateParentFolder(
            newParentId,
            teamId,
            (parentIdValue) => getTeamParent(session.user.id, parentIdValue),
          );
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

        const isCircular = await checkCircularReference(
          id,
          newParentId,
          (parentIdValue) => getTeamParent(session.user.id, parentIdValue),
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
          teamId,
          (parentIdValue) => getTeamParent(session.user.id, parentIdValue),
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

  const finalName = (updateData.name as string) ?? existing.name;
  const finalParentId =
    updateData.parentId !== undefined
      ? (updateData.parentId as string | null)
      : existing.parentId;

  if (finalName !== existing.name || finalParentId !== existing.parentId) {
    if (finalParentId) {
      const dup = await withUserTenantRls(session.user.id, async () =>
        prisma.teamFolder.findUnique({
          where: { name_parentId_teamId: { name: finalName, parentId: finalParentId, teamId: teamId } },
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
        prisma.teamFolder.findFirst({
          where: { name: finalName, parentId: null, teamId: teamId },
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
    prisma.teamFolder.update({
      where: { id },
      data: updateData,
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.FOLDER_UPDATE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_FOLDER,
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

// DELETE /api/teams/[teamId]/folders/[id] - Delete a team folder
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.teamFolder.findUnique({ where: { id } }),
  );
  if (!existing || existing.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Collect children and detect name conflicts at the target parent level.
  const children = await withUserTenantRls(session.user.id, async () =>
    prisma.teamFolder.findMany({
      where: { parentId: id },
      select: { id: true, name: true },
    }),
  );

  const siblingsAtTarget = await withUserTenantRls(session.user.id, async () =>
    prisma.teamFolder.findMany({
      where: { parentId: existing.parentId, teamId: teamId },
      select: { id: true, name: true },
    }),
  );

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

  await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction(async (tx) => {
      for (const child of children) {
        const rename = renames.find((r) => r.childId === child.id);
        await tx.teamFolder.update({
          where: { id: child.id },
          data: {
            parentId: existing.parentId,
            ...(rename ? { name: rename.newName } : {}),
          },
        });
      }
      await tx.teamPasswordEntry.updateMany({
        where: { teamFolderId: id },
        data: { teamFolderId: null },
      });
      await tx.teamFolder.delete({ where: { id } });
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.FOLDER_DELETE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_FOLDER,
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
