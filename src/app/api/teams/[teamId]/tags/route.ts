import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTeamTagSchema } from "@/lib/validations";
import {
  requireTeamMember,
  requireTeamPermission,
  TeamAuthError,
} from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/tags — List team tags
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamMember(session.user.id, teamId),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const tags = await withUserTenantRls(session.user.id, async () =>
    prisma.teamTag.findMany({
      where: { teamId: teamId },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: {
            passwords: {
              where: { deletedAt: null, isArchived: false },
            },
          },
        },
      },
    }),
  );

  return NextResponse.json(
    tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      count: t._count.passwords,
    }))
  );
}

// POST /api/teams/[teamId]/tags — Create team tag
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE),
    );
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

  const parsed = createTeamTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, color } = parsed.data;
  const team = await withUserTenantRls(session.user.id, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { tenantId: true },
    }),
  );
  if (!team) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.teamTag.findUnique({
      where: { name_teamId: { name, teamId: teamId } },
    }),
  );
  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.TAG_ALREADY_EXISTS },
      { status: 409 }
    );
  }

  const tag = await withUserTenantRls(session.user.id, async () =>
    prisma.teamTag.create({
      data: {
        name,
        color: color || null,
        teamId: teamId,
        tenantId: team.tenantId,
      },
    }),
  );

  return NextResponse.json(
    { id: tag.id, name: tag.name, color: tag.color, count: 0 },
    { status: 201 }
  );
}
