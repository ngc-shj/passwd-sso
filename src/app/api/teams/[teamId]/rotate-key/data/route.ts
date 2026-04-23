import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string }> };

/**
 * GET /api/teams/[teamId]/rotate-key/data
 * Bulk-fetch all team entries and active member public keys needed for key rotation.
 * Requires TEAM_UPDATE permission (admin or owner).
 */
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { teamKeyVersion: true },
    }),
  );

  if (!team) {
    return errorResponse(API_ERROR.TEAM_NOT_FOUND, 404);
  }

  const [entries, activeMembers] = await withTeamTenantRls(teamId, async () =>
    Promise.all([
      // All entries regardless of deletedAt / isArchived status
      prisma.teamPasswordEntry.findMany({
        where: { teamId },
        select: {
          id: true,
          encryptedBlob: true,
          blobIv: true,
          blobAuthTag: true,
          encryptedOverview: true,
          overviewIv: true,
          overviewAuthTag: true,
          teamKeyVersion: true,
          itemKeyVersion: true,
          encryptedItemKey: true,
          itemKeyIv: true,
          itemKeyAuthTag: true,
          aadVersion: true,
        },
      }),
      // Active members whose key has been distributed
      prisma.teamMember.findMany({
        where: { teamId, deactivatedAt: null, keyDistributed: true },
        select: { userId: true },
      }),
    ]),
  );

  // Fetch the latest TeamMemberKey for each active member to get their public key
  const activeMemberUserIds = activeMembers.map((m) => m.userId);

  const memberKeys = activeMemberUserIds.length > 0
    ? await withTeamTenantRls(teamId, async () =>
        prisma.teamMemberKey.findMany({
          where: { teamId, userId: { in: activeMemberUserIds } },
          orderBy: { keyVersion: "desc" },
          distinct: ["userId"],
          select: {
            userId: true,
            user: {
              select: {
                ecdhPublicKey: true,
              },
            },
          },
        }),
      )
    : [];

  const members = memberKeys
    .filter((mk) => mk.user.ecdhPublicKey != null)
    .map((mk) => ({
      userId: mk.userId,
      ecdhPublicKey: mk.user.ecdhPublicKey as string,
    }));

  return NextResponse.json({
    teamKeyVersion: team.teamKeyVersion,
    entries,
    members,
  });
}

export const GET = withRequestLog(handleGET);
