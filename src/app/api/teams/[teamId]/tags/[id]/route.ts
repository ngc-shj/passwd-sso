import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateTeamTagSchema } from "@/lib/validations";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { validateParentChain, TagTreeError } from "@/lib/tag-tree";

type Params = { params: Promise<{ teamId: string; id: string }> };

// PUT /api/teams/[teamId]/tags/[id] — Update team tag
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const tag = await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.findUnique({ where: { id } }),
  );
  if (!tag || tag.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = updateTeamTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.color !== undefined)
    updateData.color = parsed.data.color || null;

  // Handle parentId change
  const parentIdChanged = parsed.data.parentId !== undefined;
  if (parentIdChanged) {
    const newParentId = parsed.data.parentId ?? null;
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

  const updated = await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.update({
      where: { id },
      data: updateData,
    }),
  );

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    color: updated.color,
    parentId: updated.parentId,
  });
}

// DELETE /api/teams/[teamId]/tags/[id] — Delete team tag
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, id } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const tag = await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.findUnique({ where: { id } }),
  );
  if (!tag || tag.teamId !== teamId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.delete({ where: { id } }),
  );

  return NextResponse.json({ success: true });
}
