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
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma-filters";
import {
  validateParentChain,
  buildTagTree,
  flattenTagTree,
  TagTreeError,
} from "@/lib/tag-tree";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/tags — List team tags
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const tags = await withTeamTenantRls(teamId, async () =>
    prisma.teamTag.findMany({
      where: { teamId: teamId },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: {
            passwords: {
              where: { ...ACTIVE_ENTRY_WHERE },
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
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TAG_MANAGE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const result = await parseBody(req, createTeamTagSchema);
  if (!result.ok) return result.response;

  const { name, color, parentId } = result.data;
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { tenantId: true },
    }),
  );
  if (!team) {
    return notFound();
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
    return errorResponse(API_ERROR.TAG_ALREADY_EXISTS, 409);
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

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
