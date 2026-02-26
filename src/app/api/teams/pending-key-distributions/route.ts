import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_ROLE } from "@/lib/constants";

// GET /api/teams/pending-key-distributions
// Returns all pending key distributions across all teams where the user is OWNER/ADMIN.
// Used for automatic background key distribution after vault unlock.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Find teams where the user is OWNER or ADMIN and team is E2E-enabled
  const adminMemberships = await prisma.orgMember.findMany({
    where: {
      userId: session.user.id,
      role: { in: [TEAM_ROLE.OWNER, TEAM_ROLE.ADMIN] },
      deactivatedAt: null,
    },
    select: { orgId: true },
  });

  if (adminMemberships.length === 0) {
    return NextResponse.json([]);
  }

  const teamIds = adminMemberships.map((m) => m.orgId);

  // Find members who need key distribution
  const pendingMembers = await prisma.orgMember.findMany({
    where: {
      orgId: { in: teamIds },
      keyDistributed: false,
      deactivatedAt: null,
      user: {
        ecdhPublicKey: { not: null },
      },
    },
    select: {
      id: true,
      orgId: true,
      userId: true,
      user: {
        select: {
          ecdhPublicKey: true,
        },
      },
      org: {
        select: {
          orgKeyVersion: true,
        },
      },
    },
  });

  const result = pendingMembers.map((m) => ({
    memberId: m.id,
    teamId: m.orgId,
    userId: m.userId,
    ecdhPublicKey: m.user.ecdhPublicKey,
    orgKeyVersion: m.org.orgKeyVersion,
  }));

  return NextResponse.json(result);
}
