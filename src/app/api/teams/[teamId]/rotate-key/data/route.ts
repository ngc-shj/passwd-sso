import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { heldTeamKeyVersions } from "@/lib/team/team-item-key";
import { actorDepartedSinceAdmission, readTenantRows } from "@/lib/team/tenant-row-lock";

type Params = { params: Promise<{ teamId: string }> };

/**
 * GET /api/teams/[teamId]/rotate-key/data
 * Bulk-fetch all team entries and active member public keys needed for key rotation,
 * plus the team key versions the caller holds a member key for (an entry at a
 * version outside that list is carried as `not_held`).
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
    return errorResponse(API_ERROR.TEAM_NOT_FOUND);
  }

  const [entries, activeMembers, actorKeyVersions] = await withTeamTenantRls(teamId, async (tenantId) => {
    // All entries regardless of deletedAt / isArchived status
    const entries = await prisma.teamPasswordEntry.findMany({
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
        itemKeyId: true,
        aadVersion: true,
      },
    });
    // Active members whose key has been distributed, less leftover ones (their
    // tenant row departed at or after their admission): the rotation treats
    // those as deactivated and refuses a key wrapped for them.
    const keyHolders = await prisma.teamMember.findMany({
      where: { teamId, deactivatedAt: null, keyDistributed: true },
      select: { userId: true, admittedAt: true, createdAt: true },
    });
    const tenantRows = await readTenantRows(prisma, tenantId, keyHolders.map((m) => m.userId));
    const activeMembers = keyHolders.filter(
      (m) => !actorDepartedSinceAdmission(tenantRows.get(m.userId), m.admittedAt ?? m.createdAt),
    );
    const actorKeyVersions = await heldTeamKeyVersions(prisma, teamId, session.user.id);
    return [entries, activeMembers, actorKeyVersions] as const;
  });

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
          },
        }),
      )
    : [];

  const publicKeys = memberKeys.length > 0
    ? await withBypassRls(prisma, async (tx) =>
        tx.user.findMany({
          where: { id: { in: memberKeys.map((mk) => mk.userId) } },
          select: { id: true, ecdhPublicKey: true },
        }),
      BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP)
    : [];

  const publicKeyByUserId = new Map(publicKeys.map((user) => [user.id, user.ecdhPublicKey]));

  const members = memberKeys
    .filter((mk) => publicKeyByUserId.get(mk.userId) != null)
    .map((mk) => ({
      userId: mk.userId,
      ecdhPublicKey: publicKeyByUserId.get(mk.userId) as string,
    }));

  return NextResponse.json({
    teamKeyVersion: team.teamKeyVersion,
    entries,
    members,
    actorKeyVersions,
  });
}

export const GET = withRequestLog(handleGET);
