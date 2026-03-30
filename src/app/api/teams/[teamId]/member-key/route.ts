import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkAuth } from "@/lib/check-auth";
import { requireTeamMember, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/member-key — Get own TeamMemberKey
// Query: ?keyVersion=N (optional, defaults to latest)
async function handleGET(req: NextRequest, { params }: Params) {
  const authed = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_READ });
  if (!authed.ok) return authed.response;
  const { userId } = authed.auth;

  const { teamId } = await params;

  try {
    await requireTeamMember(userId, teamId);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  // Check if key has been distributed to this member
  const membership = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findFirst({
      where: { teamId: teamId, userId: userId, deactivatedAt: null },
      select: { keyDistributed: true },
    }),
  );

  if (!membership?.keyDistributed) {
    return errorResponse(API_ERROR.KEY_NOT_DISTRIBUTED, 403);
  }

  // Optional keyVersion query param (for history restore with old key)
  const keyVersionParam = req.nextUrl.searchParams.get("keyVersion");

  let memberKey;
  if (keyVersionParam) {
    const keyVersion = parseInt(keyVersionParam, 10);
    if (isNaN(keyVersion) || keyVersion < 1 || keyVersion > 10000) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
    memberKey = await withTeamTenantRls(teamId, async () =>
      prisma.teamMemberKey.findUnique({
        where: {
          teamId_userId_keyVersion: {
            teamId: teamId,
            userId: userId,
            keyVersion,
          },
        },
      }),
    );
  } else {
    // Get the latest key version
    memberKey = await withTeamTenantRls(teamId, async () =>
      prisma.teamMemberKey.findFirst({
        where: { teamId: teamId, userId: userId },
        orderBy: { keyVersion: "desc" },
      }),
    );
  }

  if (!memberKey) {
    return errorResponse(API_ERROR.MEMBER_KEY_NOT_FOUND, 404);
  }

  return NextResponse.json({
    encryptedTeamKey: memberKey.encryptedTeamKey,
    teamKeyIv: memberKey.teamKeyIv,
    teamKeyAuthTag: memberKey.teamKeyAuthTag,
    ephemeralPublicKey: memberKey.ephemeralPublicKey,
    hkdfSalt: memberKey.hkdfSalt,
    keyVersion: memberKey.keyVersion,
    wrapVersion: memberKey.wrapVersion,
  });
}

export const GET = withRequestLog(handleGET);
