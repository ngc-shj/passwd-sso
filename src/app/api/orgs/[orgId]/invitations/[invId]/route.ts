import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string; invId: string }> };

// DELETE /api/orgs/[orgId]/invitations/[invId] — Cancel invitation
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, invId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.MEMBER_INVITE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const invitation = await prisma.orgInvitation.findUnique({
    where: { id: invId },
  });

  if (!invitation || invitation.orgId !== orgId) {
    return NextResponse.json(
      { error: API_ERROR.INVITATION_NOT_FOUND },
      { status: 404 }
    );
  }

  await prisma.orgInvitation.delete({ where: { id: invId } });

  return NextResponse.json({ success: true });
}
