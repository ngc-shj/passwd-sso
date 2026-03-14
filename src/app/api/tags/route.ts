import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTagSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { withUserTenantRls } from "@/lib/tenant-context";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma-filters";
import {
  validateParentChain,
  buildTagTree,
  flattenTagTree,
  TagTreeError,
} from "@/lib/tag-tree";
import { withRequestLog } from "@/lib/with-request-log";

// GET /api/tags - List user's tags with password count
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const tags = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.findMany({
      where: { userId: session.user.id },
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

  const flat = tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    parentId: tag.parentId,
    passwordCount: tag._count.passwords,
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
        passwordCount: flat.find((f) => f.id === n.id)?.passwordCount ?? 0,
      })),
    );
  }

  return NextResponse.json(flat);
}

// POST /api/tags - Create a new tag
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await parseBody(req, createTagSchema);
  if (!result.ok) return result.response;

  const { name, color, parentId } = result.data;
  const actor = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  if (!actor) {
    return unauthorized();
  }

  // Validate parent chain if parentId is provided
  if (parentId) {
    const allTags = await withUserTenantRls(session.user.id, async () =>
      prisma.tag.findMany({
        where: { userId: session.user.id },
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

  // Check for duplicate name at the same level (same parentId)
  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.findFirst({
      where: {
        name,
        parentId: parentId ?? null,
        userId: session.user.id,
      },
    }),
  );
  if (existing) {
    return errorResponse(API_ERROR.TAG_ALREADY_EXISTS, 409);
  }

  const tag = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.create({
      data: {
        name,
        color: color || null,
        parentId: parentId ?? null,
        userId: session.user.id,
        tenantId: actor.tenantId,
      },
    }),
  );

  return NextResponse.json(
    { id: tag.id, name: tag.name, color: tag.color, parentId: tag.parentId },
    { status: 201 }
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
