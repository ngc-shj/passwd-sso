import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";

const acceptLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 10 });

// POST /api/orgs/invitations/accept — Accept an invitation by token
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await acceptLimiter.check(`rl:invite_accept:${session.user.id}`))) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { token } = body as { token?: string };
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "Token required" }, { status: 400 });
  }

  const invitation = await prisma.orgInvitation.findUnique({
    where: { token },
    include: { org: { select: { id: true, name: true, slug: true } } },
  });

  if (!invitation) {
    return NextResponse.json(
      { error: "Invalid invitation" },
      { status: 404 }
    );
  }

  if (invitation.status !== "PENDING") {
    return NextResponse.json(
      { error: "Invitation already used" },
      { status: 410 }
    );
  }

  if (invitation.expiresAt < new Date()) {
    await prisma.orgInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    return NextResponse.json(
      { error: "Invitation expired" },
      { status: 410 }
    );
  }

  // Verify the invitation email matches the authenticated user
  if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "Invitation was sent to a different email" },
      { status: 403 }
    );
  }

  // Check if already a member
  const existingMember = await prisma.orgMember.findUnique({
    where: {
      orgId_userId: {
        orgId: invitation.orgId,
        userId: session.user.id,
      },
    },
  });

  if (existingMember) {
    await prisma.orgInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED" },
    });
    return NextResponse.json({
      org: invitation.org,
      alreadyMember: true,
    });
  }

  // Create membership and mark invitation as accepted
  await prisma.$transaction([
    prisma.orgMember.create({
      data: {
        orgId: invitation.orgId,
        userId: session.user.id,
        role: invitation.role,
      },
    }),
    prisma.orgInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED" },
    }),
  ]);

  return NextResponse.json({
    org: invitation.org,
    role: invitation.role,
    alreadyMember: false,
  });
}
