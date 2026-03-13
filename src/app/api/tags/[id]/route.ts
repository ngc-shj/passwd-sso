import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateTagSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { withUserTenantRls } from "@/lib/tenant-context";
import { validateParentChain, TagTreeError } from "@/lib/tag-tree";
import { withRequestLog } from "@/lib/with-request-log";

// PUT /api/tags/[id] - Update a tag
async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.findUnique({ where: { id } }),
  );
  if (!existing) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  const result = await parseBody(req, updateTagSchema);
  if (!result.ok) return result.response;

  const updateData: Record<string, unknown> = {};
  if (result.data.name !== undefined) updateData.name = result.data.name;
  if (result.data.color !== undefined)
    updateData.color = result.data.color || null;

  // Handle parentId change
  const parentIdChanged = result.data.parentId !== undefined;
  if (parentIdChanged) {
    const newParentId = result.data.parentId ?? null;
    updateData.parentId = newParentId;

    if (newParentId) {
      const allTags = await withUserTenantRls(session.user.id, async () =>
        prisma.tag.findMany({
          where: { userId: session.user.id },
          select: { id: true, name: true, parentId: true },
        }),
      );
      try {
        validateParentChain(id, newParentId, allTags);
      } catch (e) {
        if (e instanceof TagTreeError) {
          return NextResponse.json(
            { error: API_ERROR.VALIDATION_ERROR, message: e.message },
            { status: 400 },
          );
        }
        throw e;
      }
    }
  }

  // Check for duplicate name at the same level if name or parentId is changing
  const effectiveName = (updateData.name as string) ?? existing.name;
  const effectiveParentId = parentIdChanged
    ? (updateData.parentId as string | null)
    : existing.parentId;

  if (
    effectiveName !== existing.name ||
    (parentIdChanged && effectiveParentId !== existing.parentId)
  ) {
    const duplicate = await withUserTenantRls(session.user.id, async () =>
      prisma.tag.findFirst({
        where: {
          name: effectiveName,
          parentId: effectiveParentId,
          userId: session.user.id,
          id: { not: id },
        },
      }),
    );
    if (duplicate) {
      return NextResponse.json(
        { error: API_ERROR.TAG_ALREADY_EXISTS },
        { status: 409 }
      );
    }
  }

  const tag = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.update({
      where: { id },
      data: updateData,
    }),
  );

  return NextResponse.json({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    parentId: tag.parentId,
  });
}

// DELETE /api/tags/[id] - Delete a tag
async function handleDELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.findUnique({ where: { id } }),
  );
  if (!existing) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.tag.delete({ where: { id } }),
  );

  return NextResponse.json({ success: true });
}

export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
