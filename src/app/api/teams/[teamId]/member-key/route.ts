import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgMember, OrgAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/member-key — Get own OrgMemberKey
// Query: ?keyVersion=N (optional, defaults to latest)
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId } = await params;

  try {
    await requireOrgMember(session.user.id, orgId);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Check if key has been distributed to this member
  const membership = await prisma.orgMember.findFirst({
    where: { orgId, userId: session.user.id, deactivatedAt: null },
    select: { keyDistributed: true },
  });

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
    memberKey = await prisma.orgMemberKey.findUnique({
      where: {
        orgId_userId_keyVersion: {
          orgId,
          userId: session.user.id,
          keyVersion,
        },
      },
    });
  } else {
    // Get the latest key version
    memberKey = await prisma.orgMemberKey.findFirst({
      where: { orgId, userId: session.user.id },
      orderBy: { keyVersion: "desc" },
    });
  }

  if (!memberKey) {
    return NextResponse.json(
      { error: API_ERROR.MEMBER_KEY_NOT_FOUND },
      { status: 404 }
    );
  }

  return NextResponse.json({
    encryptedOrgKey: memberKey.encryptedOrgKey,
    orgKeyIv: memberKey.orgKeyIv,
    orgKeyAuthTag: memberKey.orgKeyAuthTag,
    ephemeralPublicKey: memberKey.ephemeralPublicKey,
    hkdfSalt: memberKey.hkdfSalt,
    keyVersion: memberKey.keyVersion,
    wrapVersion: memberKey.wrapVersion,
  });
}
