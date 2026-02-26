import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createFolderSchema } from "@/lib/validations";
import {
  requireTeamMember,
  requireTeamPermission,
  TeamAuthError,
} from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { validateParentFolder, validateFolderDepth, type ParentNode } from "@/lib/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION, TEAM_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string }> };

function getTeamParent(id: string): Promise<ParentNode | null> {
  return prisma.orgFolder
    .findUnique({ where: { id }, select: { parentId: true, orgId: true } })
    .then((f) => (f ? { parentId: f.parentId, ownerId: f.orgId } : null));
}

// GET /api/teams/[teamId]/folders - List team folders with entry count
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const folders = await prisma.orgFolder.findMany({
    where: { orgId: teamId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      _count: {
        select: {
          entries: {
            where: { deletedAt: null },
          },
        },
      },
    },
  });

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
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = createFolderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { name, parentId, sortOrder } = parsed.data;

  // Parent ownership + existence check
  if (parentId) {
    try {
      await validateParentFolder(parentId, teamId, getTeamParent);
    } catch {
      return NextResponse.json(
        { error: API_ERROR.NOT_FOUND },
        { status: 404 },
      );
    }
  }

  try {
    await validateFolderDepth(parentId ?? null, teamId, getTeamParent);
  } catch {
    return NextResponse.json(
      { error: API_ERROR.FOLDER_MAX_DEPTH_EXCEEDED },
      { status: 400 },
    );
  }

  if (parentId) {
    const dup = await prisma.orgFolder.findUnique({
      where: { name_parentId_orgId: { name, parentId, orgId: teamId } },
    });
    if (dup) {
      return NextResponse.json(
        { error: API_ERROR.FOLDER_ALREADY_EXISTS },
        { status: 409 },
      );
    }
  } else {
    const rootDup = await prisma.orgFolder.findFirst({
      where: { name, parentId: null, orgId: teamId },
    });
    if (rootDup) {
      return NextResponse.json(
        { error: API_ERROR.FOLDER_ALREADY_EXISTS },
        { status: 409 },
      );
    }
  }

  const folder = await prisma.orgFolder.create({
    data: {
      name,
      parentId: parentId ?? null,
      orgId: teamId,
      sortOrder: sortOrder ?? 0,
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.FOLDER_CREATE,
    userId: session.user.id,
    orgId: teamId,
    targetType: AUDIT_TARGET_TYPE.ORG_FOLDER,
    targetId: folder.id,
    ...extractRequestMeta(req),
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
