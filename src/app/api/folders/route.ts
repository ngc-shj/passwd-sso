import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createFolderSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { validateFolderDepth, type ParentNode } from "@/lib/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants";

function getPersonalParent(id: string): Promise<ParentNode | null> {
  return prisma.folder
    .findUnique({ where: { id }, select: { parentId: true, userId: true } })
    .then((f) => (f ? { parentId: f.parentId, ownerId: f.userId } : null));
}

// GET /api/folders - List user's folders with entry count
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const folders = await prisma.folder.findMany({
    where: { userId: session.user.id },
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

// POST /api/folders - Create a new folder
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
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

  // Depth check
  try {
    await validateFolderDepth(parentId ?? null, session.user.id, getPersonalParent);
  } catch {
    return NextResponse.json(
      { error: API_ERROR.FOLDER_MAX_DEPTH_EXCEEDED },
      { status: 400 },
    );
  }

  // Duplicate check — use Prisma unique constraint for non-null parentId,
  // manual check for root folders (partial index enforces at DB level too)
  if (parentId) {
    const dup = await prisma.folder.findUnique({
      where: {
        name_parentId_userId: { name, parentId, userId: session.user.id },
      },
    });
    if (dup) {
      return NextResponse.json(
        { error: API_ERROR.FOLDER_ALREADY_EXISTS },
        { status: 409 },
      );
    }
  } else {
    const rootDup = await prisma.folder.findFirst({
      where: { name, parentId: null, userId: session.user.id },
    });
    if (rootDup) {
      return NextResponse.json(
        { error: API_ERROR.FOLDER_ALREADY_EXISTS },
        { status: 409 },
      );
    }
  }

  const folder = await prisma.folder.create({
    data: {
      name,
      parentId: parentId ?? null,
      userId: session.user.id,
      sortOrder: sortOrder ?? 0,
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.FOLDER_CREATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.FOLDER,
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
