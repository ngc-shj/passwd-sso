import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createOrgTagSchema } from "@/lib/validations";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";

type Params = { params: Promise<{ orgId: string; id: string }> };

// PUT /api/orgs/[orgId]/tags/[id] — Update org tag
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "tag:manage");
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const tag = await prisma.orgTag.findUnique({ where: { id } });
  if (!tag || tag.orgId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createOrgTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updated = await prisma.orgTag.update({
    where: { id },
    data: {
      name: parsed.data.name,
      color: parsed.data.color || null,
    },
  });

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    color: updated.color,
  });
}

// DELETE /api/orgs/[orgId]/tags/[id] — Delete org tag
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "tag:manage");
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const tag = await prisma.orgTag.findUnique({ where: { id } });
  if (!tag || tag.orgId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.orgTag.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
