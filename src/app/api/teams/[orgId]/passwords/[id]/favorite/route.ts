import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string; id: string }> };

// POST /api/teams/[orgId]/passwords/[id]/favorite — Toggle per-user favorite
export async function POST(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.PASSWORD_READ);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Verify the password belongs to this org
  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    select: { orgId: true },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Toggle: if exists, remove; if not, create
  const existing = await prisma.orgPasswordFavorite.findUnique({
    where: {
      userId_orgPasswordEntryId: {
        userId: session.user.id,
        orgPasswordEntryId: id,
      },
    },
  });

  if (existing) {
    await prisma.orgPasswordFavorite.delete({
      where: { id: existing.id },
    });
    return NextResponse.json({ isFavorite: false });
  } else {
    await prisma.orgPasswordFavorite.create({
      data: {
        userId: session.user.id,
        orgPasswordEntryId: id,
      },
    });
    return NextResponse.json({ isFavorite: true });
  }
}
