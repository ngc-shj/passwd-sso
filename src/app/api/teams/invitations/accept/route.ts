import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { INVITATION_STATUS } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

const acceptLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 10 });

// POST /api/teams/invitations/accept — Accept an invitation by token
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await acceptLimiter.check(`rl:invite_accept:${session.user.id}`))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const { token } = body as { token?: string };
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: API_ERROR.TOKEN_REQUIRED }, { status: 400 });
  }

  const invitation = await withUserTenantRls(session.user.id, async () =>
    prisma.teamInvitation.findUnique({
      where: { token },
      include: { team: { select: { id: true, name: true, slug: true } } },
    }),
  );

  if (!invitation) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_INVITATION },
      { status: 404 }
    );
  }

  if (invitation.status !== INVITATION_STATUS.PENDING) {
    return NextResponse.json(
      { error: API_ERROR.INVITATION_ALREADY_USED },
      { status: 410 }
    );
  }

  if (invitation.expiresAt < new Date()) {
    await withUserTenantRls(session.user.id, async () =>
      prisma.teamInvitation.update({
        where: { id: invitation.id },
        data: { status: INVITATION_STATUS.EXPIRED },
      }),
    );
    return NextResponse.json(
      { error: API_ERROR.INVITATION_EXPIRED },
      { status: 410 }
    );
  }

  // Verify the invitation email matches the authenticated user
  if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: API_ERROR.INVITATION_WRONG_EMAIL },
      { status: 403 }
    );
  }

  // Check if already a member (active or deactivated)
  const existingMember = await withUserTenantRls(session.user.id, async () =>
    prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: invitation.teamId,
          userId: session.user.id,
        },
      },
    }),
  );

  if (existingMember) {
    // Active member → already a member
    if (existingMember.deactivatedAt === null) {
      await withUserTenantRls(session.user.id, async () =>
        prisma.teamInvitation.update({
          where: { id: invitation.id },
          data: { status: INVITATION_STATUS.ACCEPTED },
        }),
      );
      return NextResponse.json({
        team: invitation.team,
        alreadyMember: true,
      });
    }

    // Deactivated + scimManaged → reject, IdP should re-activate
    if (existingMember.scimManaged) {
      return NextResponse.json(
        { error: API_ERROR.SCIM_MANAGED_MEMBER },
        { status: 409 }
      );
    }

    // Deactivated + !scimManaged → re-activate via invitation
  }

  // Team is always E2E-enabled.
  // Check if the user has an ECDH public key (vault set up).
  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { ecdhPublicKey: true },
    }),
  );
  const vaultSetupRequired = !user?.ecdhPublicKey;

  // Create membership (or re-activate if previously deactivated) and mark invitation as accepted.
  // keyDistributed starts as false (admin must distribute team key).
  await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction([
      prisma.teamMember.upsert({
        where: {
          teamId_userId: {
            teamId: invitation.teamId,
            userId: session.user.id,
          },
        },
        create: {
          teamId: invitation.teamId,
          userId: session.user.id,
          role: invitation.role,
          keyDistributed: false,
        },
        update: {
          role: invitation.role,
          keyDistributed: false,
          deactivatedAt: null,
          scimManaged: false,
        },
      }),
      prisma.teamInvitation.update({
        where: { id: invitation.id },
        data: { status: INVITATION_STATUS.ACCEPTED },
      }),
    ]),
  );

  return NextResponse.json({
    team: invitation.team,
    role: invitation.role,
    alreadyMember: false,
    needsKeyDistribution: true,
    vaultSetupRequired,
  });
}
