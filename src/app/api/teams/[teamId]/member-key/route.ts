import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkAuth } from "@/lib/auth/session/check-auth";
import { requireTeamMember } from "@/lib/auth/access/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, validationError } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/member-key — Get own TeamMemberKey
// Query: ?keyVersion=N (optional, defaults to latest)
async function handleGET(req: NextRequest, { params }: Params) {
  const authed = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_READ });
  if (!authed.ok) return authed.response;
  const { userId } = authed.auth;

  const { teamId } = await params;

  try {
    await requireTeamMember(userId, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // Check if key has been distributed to this member
  const membership = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findFirst({
      where: { teamId: teamId, userId: userId, deactivatedAt: null },
      select: { keyDistributed: true },
    }),
  );

  if (!membership?.keyDistributed) {
    return errorResponse(API_ERROR.KEY_NOT_DISTRIBUTED);
  }

  // Optional keyVersion query param (for history restore with old key)
  const keyVersionParam = req.nextUrl.searchParams.get("keyVersion");

  let memberKey;
  if (keyVersionParam) {
    const keyVersion = parseInt(keyVersionParam, 10);
    if (Number.isNaN(keyVersion) || keyVersion < 1 || keyVersion > 10000) {
      return validationError();
    }
    const [resolvedKey, team] = await withTeamTenantRls(teamId, async () =>
      Promise.all([
        prisma.teamMemberKey.findUnique({
          where: {
            teamId_userId_keyVersion: {
              teamId: teamId,
              userId: userId,
              keyVersion,
            },
          },
        }),
        prisma.team.findUnique({
          where: { id: teamId },
          select: { teamKeyVersion: true },
        }),
      ]),
    );
    memberKey = resolvedKey;

    // Post-authorization forensic signal (C2): a post-rotation member fetching
    // a non-latest key version is expected (history restore) but worth an
    // audit trail. Latest-version fetches (the hot no-param path) stay
    // un-audited to avoid log flood.
    if (memberKey && team && memberKey.keyVersion < team.teamKeyVersion) {
      await logAuditAsync({
        ...teamAuditBase(req, userId, teamId),
        action: AUDIT_ACTION.TEAM_MEMBER_KEY_OLD_VERSION_READ,
        targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
        targetId: userId,
        metadata: {
          teamId,
          keyVersion: memberKey.keyVersion,
          latestKeyVersion: team.teamKeyVersion,
        },
      });
    }
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
    return errorResponse(API_ERROR.MEMBER_KEY_NOT_FOUND);
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
