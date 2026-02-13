import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createOrgTagSchema } from "@/lib/validations";
import {
  requireOrgMember,
  requireOrgPermission,
  OrgAuthError,
} from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string }> };

// GET /api/orgs/[orgId]/tags — List org tags
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgMember(session.user.id, orgId);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const tags = await prisma.orgTag.findMany({
    where: { orgId },
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
  });

  return NextResponse.json(
    tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      count: t._count.passwords,
    }))
  );
}

// POST /api/orgs/[orgId]/tags — Create org tag
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.TAG_MANAGE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
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

  const parsed = createOrgTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, color } = parsed.data;

  const existing = await prisma.orgTag.findUnique({
    where: { name_orgId: { name, orgId } },
  });
  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.TAG_ALREADY_EXISTS },
      { status: 409 }
    );
  }

  const tag = await prisma.orgTag.create({
    data: {
      name,
      color: color || null,
      orgId,
    },
  });

  return NextResponse.json(
    { id: tag.id, name: tag.name, color: tag.color, count: 0 },
    { status: 201 }
  );
}
