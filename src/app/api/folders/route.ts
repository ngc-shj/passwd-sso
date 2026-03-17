import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createFolderSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, notFound } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { validateParentFolder, validateFolderDepth, type ParentNode } from "@/lib/folder-utils";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma-filters";
import { withRequestLog } from "@/lib/with-request-log";

function getPersonalParent(userId: string, id: string): Promise<ParentNode | null> {
  return withUserTenantRls(userId, async () => {
    const f = await prisma.folder.findUnique({
      where: { id },
      select: { parentId: true, userId: true },
    });
    return f ? { parentId: f.parentId, ownerId: f.userId } : null;
  });
}

// GET /api/folders - List user's folders with entry count
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const folders = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.findMany({
      where: { userId: session.user.id },
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

// POST /api/folders - Create a new folder
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await parseBody(req, createFolderSchema);
  if (!result.ok) return result.response;

  const { name, parentId, sortOrder } = result.data;
  const actor = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  if (!actor) {
    return unauthorized();
  }

  // Parent ownership + existence check
  if (parentId) {
    try {
      await validateParentFolder(
        parentId, session.user.id,
        (pid) => getPersonalParent(session.user.id, pid),
      );
    } catch {
      return notFound();
    }
  }

  // Depth check
  try {
    await validateFolderDepth(
      parentId ?? null, session.user.id,
      (pid) => getPersonalParent(session.user.id, pid),
    );
  } catch {
    return errorResponse(API_ERROR.FOLDER_MAX_DEPTH_EXCEEDED, 400);
  }

  // Duplicate check — use Prisma unique constraint for non-null parentId,
  // manual check for root folders (partial index enforces at DB level too)
  if (parentId) {
    const dup = await withUserTenantRls(session.user.id, async () =>
      prisma.folder.findUnique({
        where: {
          name_parentId_userId: { name, parentId, userId: session.user.id },
        },
      }),
    );
    if (dup) {
      return errorResponse(API_ERROR.FOLDER_ALREADY_EXISTS, 409);
    }
  } else {
    const rootDup = await withUserTenantRls(session.user.id, async () =>
      prisma.folder.findFirst({
        where: { name, parentId: null, userId: session.user.id },
      }),
    );
    if (rootDup) {
      return errorResponse(API_ERROR.FOLDER_ALREADY_EXISTS, 409);
    }
  }

  const folder = await withUserTenantRls(session.user.id, async () =>
    prisma.folder.create({
      data: {
        name,
        parentId: parentId ?? null,
        userId: session.user.id,
        tenantId: actor.tenantId,
        sortOrder: sortOrder ?? 0,
      },
    }),
  );

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

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
