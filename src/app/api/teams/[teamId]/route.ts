import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateTeamSchema } from "@/lib/validations";
import {
  requireTeamMember,
  requireTeamPermission,
  TeamAuthError,
} from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId] — Get team details
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    const membership = await requireTeamMember(session.user.id, teamId);
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { members: true, passwords: true } },
      },
    });

    if (!team) {
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
    }

    return NextResponse.json({
      ...team,
      role: membership.role,
      memberCount: team._count.members,
      passwordCount: team._count.passwords,
    });
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// PUT /api/teams/[teamId] — Update team
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
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

  const parsed = updateTeamSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.description !== undefined) {
    updateData.description = parsed.data.description || null;
  }

  const team = await prisma.team.update({
    where: { id: teamId },
    data: updateData,
  });

  return NextResponse.json({
    id: team.id,
    name: team.name,
    slug: team.slug,
    description: team.description,
    updatedAt: team.updatedAt,
  });
}

// DELETE /api/teams/[teamId] — Delete team (OWNER only)
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_DELETE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  await prisma.team.delete({ where: { id: teamId } });

  return NextResponse.json({ success: true });
}
