import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateTeamTagSchema } from "@/lib/validations";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { validateParentChain, TagTreeError } from "@/lib/tag-tree";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; id: string }> };

// PUT /api/teams/[teamId]/tags/[id] — Update team tag
async function handlePUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const tag = await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.findUnique({ where: { id } }),
  );
  if (!tag || tag.teamId !== teamId) {
    return notFound();
  }

  const result = await parseBody(req, updateTeamTagSchema);
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
      const allTags = await withTeamTenantRls(teamId, async () =>
        prisma.teamTag.findMany({
          where: { teamId },
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

  // Check for duplicate name at the same level
  const effectiveName = (updateData.name as string) ?? tag.name;
  const effectiveParentId = parentIdChanged
    ? (updateData.parentId as string | null)
    : tag.parentId;

  if (effectiveName !== tag.name || (parentIdChanged && effectiveParentId !== tag.parentId)) {
    const duplicate = await withTeamTenantRls(teamId, async () =>
      prisma.teamTag.findFirst({
        where: {
          name: effectiveName,
          parentId: effectiveParentId,
          teamId,
          id: { not: id },
        },
      }),
    );
    if (duplicate) {
      return NextResponse.json(
        { error: API_ERROR.TAG_ALREADY_EXISTS },
        { status: 409 },
      );
    }
  }

  let updated;
  try {
    updated = await withTeamTenantRls(teamId, async () =>
      prisma.teamTag.update({
        where: { id },
        data: updateData,
      }),
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return errorResponse(API_ERROR.TAG_ALREADY_EXISTS, 409);
    }
    throw err;
  }

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    color: updated.color,
    parentId: updated.parentId,
  });
}

// DELETE /api/teams/[teamId]/tags/[id] — Delete team tag
async function handleDELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const tag = await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.findUnique({ where: { id } }),
  );
  if (!tag || tag.teamId !== teamId) {
    return notFound();
  }

  await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.delete({ where: { id } }),
  );

  return NextResponse.json({ success: true });
}

export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
