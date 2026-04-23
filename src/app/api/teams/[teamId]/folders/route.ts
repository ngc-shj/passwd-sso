import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { createFolderSchema } from "@/lib/validations";
import {
  requireTeamMember,
  requireTeamPermission,
} from "@/lib/auth/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { validateParentFolder, validateFolderDepth, type ParentNode } from "@/lib/folder/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma/prisma-filters";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string }> };

function getTeamParent(teamId: string, id: string): Promise<ParentNode | null> {
  return withTeamTenantRls(teamId, async () =>
    prisma.teamFolder
      .findUnique({ where: { id }, select: { parentId: true, teamId: true } })
      .then((f) => (f ? { parentId: f.parentId, ownerId: f.teamId } : null)),
  );
}

// GET /api/teams/[teamId]/folders - List team folders with entry count
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const folders = await withTeamTenantRls(teamId, async () =>
    prisma.teamFolder.findMany({
      where: { teamId: teamId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        _count: {
          select: {
            entries: {
              where: { ...ACTIVE_ENTRY_WHERE },
            },
          },
        },
      },
    }),
  );

  return NextResponse.json(
    folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      sortOrder: f.sortOrder,
      entryCount: f._count.entries,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
  );
}

// POST /api/teams/[teamId]/folders - Create a team folder
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const result = await parseBody(req, createFolderSchema);
  if (!result.ok) return result.response;

  const { name, parentId, sortOrder } = result.data;

  // Parent ownership + existence check
  if (parentId) {
    try {
      await validateParentFolder(
        parentId,
        teamId,
        (parentIdValue) => getTeamParent(teamId, parentIdValue),
      );
    } catch {
      return NextResponse.json(
        { error: API_ERROR.NOT_FOUND },
        { status: 404 },
      );
    }
  }

  try {
    await validateFolderDepth(
      parentId ?? null,
      teamId,
      (parentIdValue) => getTeamParent(teamId, parentIdValue),
    );
  } catch {
    return NextResponse.json(
      { error: API_ERROR.FOLDER_MAX_DEPTH_EXCEEDED },
      { status: 400 },
    );
  }

  if (parentId) {
    const dup = await withTeamTenantRls(teamId, async () =>
      prisma.teamFolder.findUnique({
        where: { name_parentId_teamId: { name, parentId, teamId: teamId } },
      }),
    );
    if (dup) {
      return NextResponse.json(
        { error: API_ERROR.FOLDER_ALREADY_EXISTS },
        { status: 409 },
      );
    }
  } else {
    const rootDup = await withTeamTenantRls(teamId, async () =>
      prisma.teamFolder.findFirst({
        where: { name, parentId: null, teamId: teamId },
      }),
    );
    if (rootDup) {
      return NextResponse.json(
        { error: API_ERROR.FOLDER_ALREADY_EXISTS },
        { status: 409 },
      );
    }
  }

  const folder = await withTeamTenantRls(teamId, async (tenantId) =>
    prisma.teamFolder.create({
      data: {
        name,
        parentId: parentId ?? null,
        teamId: teamId,
        tenantId,
        sortOrder: sortOrder ?? 0,
      },
    }),
  );

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.FOLDER_CREATE,
    targetType: AUDIT_TARGET_TYPE.TEAM_FOLDER,
    targetId: folder.id,
  });

  return NextResponse.json(
    {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      sortOrder: folder.sortOrder,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    },
    { status: 201 },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
