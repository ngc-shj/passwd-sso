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
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION, ORG_ROLE, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string; memberId: string }> };

// PUT /api/orgs/[orgId]/members/[memberId] — Change member role
export async function PUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, memberId } = await params;

  let actorMembership;
  try {
    actorMembership = await requireOrgPermission(
      session.user.id,
      orgId,
      ORG_PERMISSION.MEMBER_CHANGE_ROLE
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

  if (!target || target.orgId !== orgId || target.deactivatedAt !== null) {
    return NextResponse.json({ error: API_ERROR.MEMBER_NOT_FOUND }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = updateMemberRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Owner transfer: only OWNER can promote someone to OWNER
  if (parsed.data.role === ORG_ROLE.OWNER) {
    if (actorMembership.role !== ORG_ROLE.OWNER) {
      return NextResponse.json(
        { error: API_ERROR.OWNER_ONLY },
        { status: 403 }
      );
    }

    // Transfer: promote target to OWNER, demote self to ADMIN
    await prisma.orgMember.update({
      where: { id: actorMembership.id },
      data: { role: ORG_ROLE.ADMIN },
    });

    const updated = await prisma.orgMember.update({
      where: { id: memberId },
      data: { role: ORG_ROLE.OWNER },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    logAudit({
      scope: AUDIT_SCOPE.ORG,
      action: AUDIT_ACTION.ORG_ROLE_UPDATE,
      userId: session.user.id,
      orgId,
      targetType: AUDIT_TARGET_TYPE.ORG_MEMBER,
      targetId: memberId,
      metadata: { newRole: ORG_ROLE.OWNER, previousRole: target.role, transfer: true },
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
  if (target.role === ORG_ROLE.OWNER) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_CHANGE_OWNER_ROLE },
      { status: 403 }
    );
  }

  // Cannot change role of someone at or above your level (except OWNER can do anything)
  if (
    actorMembership.role !== ORG_ROLE.OWNER &&
    !isRoleAbove(actorMembership.role, target.role)
  ) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_CHANGE_HIGHER_ROLE },
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
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.ORG_ROLE_UPDATE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_MEMBER,
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
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, memberId } = await params;

  let actorMembership;
  try {
    actorMembership = await requireOrgPermission(
      session.user.id,
      orgId,
      ORG_PERMISSION.MEMBER_REMOVE
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

  if (!target || target.orgId !== orgId || target.deactivatedAt !== null) {
    return NextResponse.json({ error: API_ERROR.MEMBER_NOT_FOUND }, { status: 404 });
  }

  if (target.role === ORG_ROLE.OWNER) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_REMOVE_OWNER },
      { status: 403 }
    );
  }

  if (
    actorMembership.role !== ORG_ROLE.OWNER &&
    !isRoleAbove(actorMembership.role, target.role)
  ) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_REMOVE_HIGHER_ROLE },
      { status: 403 }
    );
  }

  await prisma.$transaction([
    prisma.orgMemberKey.deleteMany({ where: { orgId, userId: target.userId } }),
    prisma.orgMember.delete({ where: { id: memberId } }),
  ]);

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.ORG_MEMBER_REMOVE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_MEMBER,
    targetId: memberId,
    metadata: { removedUserId: target.userId, removedRole: target.role },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
