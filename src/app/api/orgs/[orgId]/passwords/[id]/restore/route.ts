import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";

type Params = { params: Promise<{ orgId: string; id: string }> };

// POST /api/orgs/[orgId]/passwords/[id]/restore — Restore from trash
export async function POST(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "password:delete");
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const existing = await prisma.orgPasswordEntry.findUnique({
    where: { id },
  });

  if (!existing || existing.orgId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!existing.deletedAt) {
    return NextResponse.json(
      { error: "Not in trash" },
      { status: 400 }
    );
  }

  await prisma.orgPasswordEntry.update({
    where: { id },
    data: { deletedAt: null },
  });

  return NextResponse.json({ success: true });
}
