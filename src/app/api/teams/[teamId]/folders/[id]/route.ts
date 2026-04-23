import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit";
import { updateFolderSchema } from "@/lib/validations";
import { requireTeamPermission } from "@/lib/auth/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import {
  validateParentFolder,
  validateFolderDepth,
  checkCircularReference,
  type ParentNode,
} from "@/lib/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; id: string }> };

function getTeamParent(teamId: string, id: string): Promise<ParentNode | null> {
  return withTeamTenantRls(teamId, async () =>
    prisma.teamFolder
      .findUnique({ where: { id }, select: { parentId: true, teamId: true } })
      .then((f) => (f ? { parentId: f.parentId, ownerId: f.teamId } : null)),
  );
}

// PUT /api/teams/[teamId]/folders/[id] - Update a team folder
async function handlePUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const existing = await withTeamTenantRls(teamId, async () =>
    prisma.teamFolder.findUnique({ where: { id } }),
  );
  if (!existing || existing.teamId !== teamId) {
    return notFound();
  }

  const result = await parseBody(req, updateFolderSchema);
  if (!result.ok) return result.response;

  const { name, parentId, sortOrder } = result.data;
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
            (parentIdValue) => getTeamParent(teamId, parentIdValue),
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
          (parentIdValue) => getTeamParent(teamId, parentIdValue),
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
          (parentIdValue) => getTeamParent(teamId, parentIdValue),
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
      const dup = await withTeamTenantRls(teamId, async () =>
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
      const rootDup = await withTeamTenantRls(teamId, async () =>
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

  let folder;
  try {
    folder = await withTeamTenantRls(teamId, async () =>
      prisma.teamFolder.update({
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
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.FOLDER_UPDATE,
    targetType: AUDIT_TARGET_TYPE.TEAM_FOLDER,
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

// DELETE /api/teams/[teamId]/folders/[id] - Delete a team folder
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const existing = await withTeamTenantRls(teamId, async () =>
    prisma.teamFolder.findUnique({ where: { id } }),
  );
  if (!existing || existing.teamId !== teamId) {
    return notFound();
  }

  // Collect children and detect name conflicts at the target parent level.
  await withTeamTenantRls(teamId, async () =>
    prisma.$transaction(async (tx) => {
      // Fetch children and siblings inside the transaction to avoid TOCTOU
      const children = await tx.teamFolder.findMany({
        where: { parentId: id },
        select: { id: true, name: true },
      });

      const siblingsAtTarget = await tx.teamFolder.findMany({
        where: { parentId: existing.parentId, teamId: teamId },
        select: { id: true, name: true },
      });

      const usedNames = new Set(
        siblingsAtTarget
          .filter((s) => s.id !== id)
          .map((s) => s.name),
      );

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

      for (const child of children) {
        const newName = renames.get(child.id);
        await tx.teamFolder.update({
          where: { id: child.id },
          data: {
            parentId: existing.parentId,
            ...(newName ? { name: newName } : {}),
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

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.FOLDER_DELETE,
    targetType: AUDIT_TARGET_TYPE.TEAM_FOLDER,
    targetId: id,
  });

  return NextResponse.json({ success: true });
}

export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
