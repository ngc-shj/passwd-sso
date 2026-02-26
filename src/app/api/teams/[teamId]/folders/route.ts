import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createFolderSchema } from "@/lib/validations";
import {
  requireOrgMember,
  requireOrgPermission,
  OrgAuthError,
} from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { validateParentFolder, validateFolderDepth, type ParentNode } from "@/lib/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION, TEAM_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string }> };

function getOrgParent(id: string): Promise<ParentNode | null> {
  return prisma.orgFolder
    .findUnique({ where: { id }, select: { parentId: true, orgId: true } })
    .then((f) => (f ? { parentId: f.parentId, ownerId: f.orgId } : null));
}

// GET /api/teams/[teamId]/folders - List org folders with entry count
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId } = await params;

  try {
    await requireOrgMember(session.user.id, orgId);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const folders = await prisma.orgFolder.findMany({
    where: { orgId },
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

// POST /api/teams/[teamId]/folders - Create an org folder
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, TEAM_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
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
      await validateParentFolder(parentId, orgId, getOrgParent);
    } catch {
      return NextResponse.json(
        { error: API_ERROR.NOT_FOUND },
        { status: 404 },
      );
    }
  }

  try {
    await validateFolderDepth(parentId ?? null, orgId, getOrgParent);
  } catch {
    return NextResponse.json(
      { error: API_ERROR.FOLDER_MAX_DEPTH_EXCEEDED },
      { status: 400 },
    );
  }

  if (parentId) {
    const dup = await prisma.orgFolder.findUnique({
      where: { name_parentId_orgId: { name, parentId, orgId } },
    });
    if (dup) {
      return NextResponse.json(
        { error: API_ERROR.FOLDER_ALREADY_EXISTS },
        { status: 409 },
      );
    }
  } else {
    const rootDup = await prisma.orgFolder.findFirst({
      where: { name, parentId: null, orgId },
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
      orgId,
      sortOrder: sortOrder ?? 0,
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.FOLDER_CREATE,
    userId: session.user.id,
    orgId,
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
