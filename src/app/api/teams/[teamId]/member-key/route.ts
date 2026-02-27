import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { withUserTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/member-key — Get own TeamMemberKey
// Query: ?keyVersion=N (optional, defaults to latest)
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamMember(session.user.id, teamId),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Check if key has been distributed to this member
  const membership = await withUserTenantRls(session.user.id, async () =>
    prisma.teamMember.findFirst({
      where: { teamId: teamId, userId: session.user.id, deactivatedAt: null },
      select: { keyDistributed: true },
    }),
  );

  if (!membership?.keyDistributed) {
    return NextResponse.json(
      { error: API_ERROR.KEY_NOT_DISTRIBUTED },
      { status: 403 }
    );
  }

  // Optional keyVersion query param (for history restore with old key)
  const keyVersionParam = req.nextUrl.searchParams.get("keyVersion");

  let memberKey;
  if (keyVersionParam) {
    const keyVersion = parseInt(keyVersionParam, 10);
    if (isNaN(keyVersion) || keyVersion < 1 || keyVersion > 10000) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR },
        { status: 400 }
      );
    }
    memberKey = await withUserTenantRls(session.user.id, async () =>
      prisma.teamMemberKey.findUnique({
        where: {
          teamId_userId_keyVersion: {
            teamId: teamId,
            userId: session.user.id,
            keyVersion,
          },
        },
      }),
    );
  } else {
    // Get the latest key version
    memberKey = await withUserTenantRls(session.user.id, async () =>
      prisma.teamMemberKey.findFirst({
        where: { teamId: teamId, userId: session.user.id },
        orderBy: { keyVersion: "desc" },
      }),
    );
  }

  if (!memberKey) {
    return NextResponse.json(
      { error: API_ERROR.MEMBER_KEY_NOT_FOUND },
      { status: 404 }
    );
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
