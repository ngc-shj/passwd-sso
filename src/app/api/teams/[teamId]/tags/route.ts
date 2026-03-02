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
import { withTeamTenantRls } from "@/lib/tenant-context";
import {
  validateParentChain,
  buildTagTree,
  flattenTagTree,
  TagTreeError,
} from "@/lib/tag-tree";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/tags — List team tags
export async function GET(req: NextRequest, { params }: Params) {
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

  const tags = await withTeamTenantRls(teamId, async () =>
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

  const wantTree = req.nextUrl.searchParams.get("tree") === "true";

  const flat = tags.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    parentId: t.parentId,
    count: t._count.passwords,
  }));

  if (wantTree) {
    const tree = buildTagTree(flat);
    const ordered = flattenTagTree(tree);
    return NextResponse.json(
      ordered.map((n) => ({
        id: n.id,
        name: n.name,
        color: n.color,
        parentId: n.parentId,
        depth: n.depth,
        count: flat.find((f) => f.id === n.id)?.count ?? 0,
      })),
    );
  }

  return NextResponse.json(flat);
}

// POST /api/teams/[teamId]/tags — Create team tag
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

  const parsed = createTeamTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, color, parentId } = parsed.data;
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { tenantId: true },
    }),
  );
  if (!team) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Validate parent chain if parentId is provided
  if (parentId) {
    const allTags = await withTeamTenantRls(teamId, async () =>
      prisma.teamTag.findMany({
        where: { teamId },
        select: { id: true, name: true, parentId: true },
      }),
    );
    try {
      validateParentChain(null, parentId, allTags);
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

  // Check for duplicate name at the same level
  const existing = await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.findFirst({
      where: {
        name,
        parentId: parentId ?? null,
        teamId,
      },
    }),
  );
  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.TAG_ALREADY_EXISTS },
      { status: 409 }
    );
  }

  const tag = await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.create({
      data: {
        name,
        color: color || null,
        parentId: parentId ?? null,
        teamId: teamId,
        tenantId: team.tenantId,
      },
    }),
  );

  return NextResponse.json(
    { id: tag.id, name: tag.name, color: tag.color, parentId: tag.parentId, count: 0 },
    { status: 201 }
  );
}
