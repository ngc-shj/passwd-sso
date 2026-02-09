import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { updateMemberRoleSchema } from "@/lib/validations";
import {
  requireOrgPermission,
  isRoleAbove,
  OrgAuthError,
} from "@/lib/org-auth";

type Params = { params: Promise<{ orgId: string; memberId: string }> };

// PUT /api/orgs/[orgId]/members/[memberId] — Change member role
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, memberId } = await params;

  let actorMembership;
  try {
    actorMembership = await requireOrgPermission(
      session.user.id,
      orgId,
      "member:changeRole"
    );
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const target = await prisma.orgMember.findUnique({
    where: { id: memberId },
  });

  if (!target || target.orgId !== orgId) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateMemberRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Owner transfer: only OWNER can promote someone to OWNER
  if (parsed.data.role === "OWNER") {
    if (actorMembership.role !== "OWNER") {
      return NextResponse.json(
        { error: "Only the owner can transfer ownership" },
        { status: 403 }
      );
    }

    // Transfer: promote target to OWNER, demote self to ADMIN
    await prisma.orgMember.update({
      where: { id: actorMembership.id },
      data: { role: "ADMIN" },
    });

    const updated = await prisma.orgMember.update({
      where: { id: memberId },
      data: { role: "OWNER" },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    logAudit({
      scope: "ORG",
      action: "ORG_ROLE_UPDATE",
      userId: session.user.id,
      orgId,
      targetType: "OrgMember",
      targetId: memberId,
      metadata: { newRole: "OWNER", previousRole: target.role, transfer: true },
      ...extractRequestMeta(req),
    });

    return NextResponse.json({
      id: updated.id,
      userId: updated.userId,
      role: updated.role,
      name: updated.user.name,
      email: updated.user.email,
      image: updated.user.image,
    });
  }

  // Cannot change OWNER role (unless transferring ownership above)
  if (target.role === "OWNER") {
    return NextResponse.json(
      { error: "Cannot change the owner's role" },
      { status: 403 }
    );
  }

  // Cannot change role of someone at or above your level (except OWNER can do anything)
  if (
    actorMembership.role !== "OWNER" &&
    !isRoleAbove(actorMembership.role, target.role)
  ) {
    return NextResponse.json(
      { error: "Cannot change role of a member at or above your level" },
      { status: 403 }
    );
  }

  const updated = await prisma.orgMember.update({
    where: { id: memberId },
    data: { role: parsed.data.role },
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  });

  logAudit({
    scope: "ORG",
    action: "ORG_ROLE_UPDATE",
    userId: session.user.id,
    orgId,
    targetType: "OrgMember",
    targetId: memberId,
    metadata: { newRole: parsed.data.role, previousRole: target.role },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({
    id: updated.id,
    userId: updated.userId,
    role: updated.role,
    name: updated.user.name,
    email: updated.user.email,
    image: updated.user.image,
  });
}

// DELETE /api/orgs/[orgId]/members/[memberId] — Remove member
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, memberId } = await params;

  let actorMembership;
  try {
    actorMembership = await requireOrgPermission(
      session.user.id,
      orgId,
      "member:remove"
    );
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const target = await prisma.orgMember.findUnique({
    where: { id: memberId },
  });

  if (!target || target.orgId !== orgId) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (target.role === "OWNER") {
    return NextResponse.json(
      { error: "Cannot remove the owner" },
      { status: 403 }
    );
  }

  if (
    actorMembership.role !== "OWNER" &&
    !isRoleAbove(actorMembership.role, target.role)
  ) {
    return NextResponse.json(
      { error: "Cannot remove a member at or above your level" },
      { status: 403 }
    );
  }

  await prisma.orgMember.delete({ where: { id: memberId } });

  logAudit({
    scope: "ORG",
    action: "ORG_MEMBER_REMOVE",
    userId: session.user.id,
    orgId,
    targetType: "OrgMember",
    targetId: memberId,
    metadata: { removedUserId: target.userId, removedRole: target.role },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
