import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { unauthorized } from "@/lib/http/api-response";
import { TEAM_ROLE } from "@/lib/constants";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { departedPairKey, departedPairs } from "@/lib/team/team-departure";
import { withRequestLog } from "@/lib/http/with-request-log";

// GET /api/teams/pending-key-distributions
// Returns all pending key distributions across all teams where the user is OWNER/ADMIN.
// Used for automatic background key distribution after vault unlock.
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  // Find teams where the user is OWNER or ADMIN and team is E2E-enabled
  const adminMemberships = await withBypassRls(prisma, async (tx) =>
    tx.teamMember.findMany({
      where: {
        userId: session.user.id,
        role: { in: [TEAM_ROLE.OWNER, TEAM_ROLE.ADMIN] },
        deactivatedAt: null,
      },
      select: { teamId: true },
    }),
  BYPASS_GRANT.TEAM_PENDING_KEY_DISTRIBUTION);

  if (adminMemberships.length === 0) {
    return NextResponse.json([]);
  }

  const teamIds = adminMemberships.map((m) => m.teamId);

  // Find members who need key distribution
  const pendingMembers = await withBypassRls(prisma, async (tx) =>
    tx.teamMember.findMany({
      where: {
        teamId: { in: teamIds },
        keyDistributed: false,
        deactivatedAt: null,
        user: {
          ecdhPublicKey: { not: null },
        },
      },
      select: {
        id: true,
        teamId: true,
        userId: true,
        tenantId: true,
        user: {
          select: {
            ecdhPublicKey: true,
          },
        },
        team: {
          select: {
            teamKeyVersion: true,
          },
        },
      },
    }),
  BYPASS_GRANT.TEAM_PENDING_KEY_DISTRIBUTION);

  // A member who departed the team's tenant is not distributed a key, though
  // their distribution is pending (team-departure.ts); reactivation lists
  // them again.
  const departed = await withBypassRls(prisma, async (tx) =>
    departedPairs(tx, pendingMembers),
  BYPASS_GRANT.TEAM_PENDING_KEY_DISTRIBUTION);

  const result = pendingMembers.filter((m) => !departed.has(departedPairKey(m))).map((m) => ({
    memberId: m.id,
    teamId: m.teamId,
    userId: m.userId,
    ecdhPublicKey: m.user.ecdhPublicKey,
    teamKeyVersion: m.team.teamKeyVersion,
  }));

  return NextResponse.json(result);
}

export const GET = withRequestLog(handleGET);
