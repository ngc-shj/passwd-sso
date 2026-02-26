import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateOrgSchema } from "@/lib/validations";
import {
  requireOrgMember,
  requireOrgPermission,
  OrgAuthError,
} from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId] — Get organization details
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId } = await params;

  try {
    const membership = await requireOrgMember(session.user.id, orgId);
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
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

    if (!org) {
      return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
    }

    return NextResponse.json({
      ...org,
      role: membership.role,
      memberCount: org._count.members,
      passwordCount: org._count.passwords,
    });
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// PUT /api/teams/[teamId] — Update organization
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.ORG_UPDATE);
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

  const parsed = updateOrgSchema.safeParse(body);
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

  const org = await prisma.organization.update({
    where: { id: orgId },
    data: updateData,
  });

  return NextResponse.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    description: org.description,
    updatedAt: org.updatedAt,
  });
}

// DELETE /api/teams/[teamId] — Delete organization (OWNER only)
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.ORG_DELETE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  await prisma.organization.delete({ where: { id: orgId } });

  return NextResponse.json({ success: true });
}
