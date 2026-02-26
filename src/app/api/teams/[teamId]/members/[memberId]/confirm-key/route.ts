import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { teamMemberKeySchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

// POST /api/teams/[teamId]/members/[memberId]/confirm-key
// Admin distributes the team key to a member by encrypting it with member's ECDH public key
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, memberId } = await params;

  // Only OWNER/ADMIN can distribute keys (mapped to MEMBER_INVITE permission)
  try {
    await requireTeamPermission(
      session.user.id,
      teamId,
      TEAM_PERMISSION.MEMBER_INVITE
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Verify target member exists, belongs to this team, and is active
  const targetMember = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { teamId: true, userId: true, keyDistributed: true, deactivatedAt: true },
  });

  if (!targetMember || targetMember.teamId !== teamId || targetMember.deactivatedAt !== null) {
    return NextResponse.json(
      { error: API_ERROR.MEMBER_NOT_FOUND },
      { status: 404 }
    );
  }

  // Verify the target user has an ECDH public key (vault set up)
  const targetUser = await prisma.user.findUnique({
    where: { id: targetMember.userId },
    select: { ecdhPublicKey: true },
  });

  if (!targetUser?.ecdhPublicKey) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_NOT_READY },
      { status: 409 }
    );
  }

  // Prevent overwriting an already-distributed key (S-11)
  if (targetMember.keyDistributed) {
    return NextResponse.json(
      { error: API_ERROR.KEY_ALREADY_DISTRIBUTED },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = teamMemberKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;

  // Atomic check-and-set: re-verify keyDistributed + deactivatedAt + teamKeyVersion inside transaction (S-12/F-16/S-24)
  const distributed = await prisma.$transaction(async (tx) => {
    const member = await tx.teamMember.findUnique({
      where: { id: memberId },
      select: { keyDistributed: true, deactivatedAt: true },
    });
    if (!member || member.deactivatedAt !== null) return "member_not_found" as const;
    if (member.keyDistributed) return "already_distributed" as const;

    // Verify keyVersion matches current team key version (F-16)
    const team = await tx.team.findUnique({
      where: { id: teamId },
      select: { teamKeyVersion: true },
    });
    if (!team || data.keyVersion !== team.teamKeyVersion) {
      return "version_mismatch" as const;
    }

    await tx.teamMemberKey.upsert({
      where: {
        teamId_userId_keyVersion: {
          teamId: teamId,
          userId: targetMember.userId,
          keyVersion: data.keyVersion,
        },
      },
      create: {
        teamId: teamId,
        userId: targetMember.userId,
        encryptedTeamKey: data.encryptedTeamKey,
        teamKeyIv: data.teamKeyIv,
        teamKeyAuthTag: data.teamKeyAuthTag,
        ephemeralPublicKey: data.ephemeralPublicKey,
        hkdfSalt: data.hkdfSalt,
        keyVersion: data.keyVersion,
        wrapVersion: data.wrapVersion,
      },
      update: {
        encryptedTeamKey: data.encryptedTeamKey,
        teamKeyIv: data.teamKeyIv,
        teamKeyAuthTag: data.teamKeyAuthTag,
        ephemeralPublicKey: data.ephemeralPublicKey,
        hkdfSalt: data.hkdfSalt,
        wrapVersion: data.wrapVersion,
      },
    });

    await tx.teamMember.update({
      where: { id: memberId },
      data: { keyDistributed: true },
    });

    return "success" as const;
  });

  if (distributed === "member_not_found") {
    return NextResponse.json(
      { error: API_ERROR.MEMBER_NOT_FOUND },
      { status: 404 }
    );
  }
  if (distributed === "already_distributed") {
    return NextResponse.json(
      { error: API_ERROR.KEY_ALREADY_DISTRIBUTED },
      { status: 409 }
    );
  }
  if (distributed === "version_mismatch") {
    return NextResponse.json(
      { error: API_ERROR.TEAM_KEY_VERSION_MISMATCH },
      { status: 409 }
    );
  }

  return NextResponse.json({ success: true });
}
