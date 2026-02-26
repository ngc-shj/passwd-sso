import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { orgMemberKeySchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

// POST /api/teams/[teamId]/members/[memberId]/confirm-key
// Admin distributes the org key to a member by encrypting it with member's ECDH public key
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId, memberId } = await params;

  // Only OWNER/ADMIN can distribute keys (mapped to MEMBER_INVITE permission)
  try {
    await requireTeamPermission(
      session.user.id,
      orgId,
      TEAM_PERMISSION.MEMBER_INVITE
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Verify target member exists, belongs to this org, and is active
  const targetMember = await prisma.orgMember.findUnique({
    where: { id: memberId },
    select: { orgId: true, userId: true, keyDistributed: true, deactivatedAt: true },
  });

  if (!targetMember || targetMember.orgId !== orgId || targetMember.deactivatedAt !== null) {
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

  const parsed = orgMemberKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;

  // Atomic check-and-set: re-verify keyDistributed + deactivatedAt + orgKeyVersion inside transaction (S-12/F-16/S-24)
  const distributed = await prisma.$transaction(async (tx) => {
    const member = await tx.orgMember.findUnique({
      where: { id: memberId },
      select: { keyDistributed: true, deactivatedAt: true },
    });
    if (!member || member.deactivatedAt !== null) return "member_not_found" as const;
    if (member.keyDistributed) return "already_distributed" as const;

    // Verify keyVersion matches current org key version (F-16)
    const org = await tx.organization.findUnique({
      where: { id: orgId },
      select: { orgKeyVersion: true },
    });
    if (!org || data.keyVersion !== org.orgKeyVersion) {
      return "version_mismatch" as const;
    }

    await tx.orgMemberKey.upsert({
      where: {
        orgId_userId_keyVersion: {
          orgId,
          userId: targetMember.userId,
          keyVersion: data.keyVersion,
        },
      },
      create: {
        orgId,
        userId: targetMember.userId,
        encryptedOrgKey: data.encryptedOrgKey,
        orgKeyIv: data.orgKeyIv,
        orgKeyAuthTag: data.orgKeyAuthTag,
        ephemeralPublicKey: data.ephemeralPublicKey,
        hkdfSalt: data.hkdfSalt,
        keyVersion: data.keyVersion,
        wrapVersion: data.wrapVersion,
      },
      update: {
        encryptedOrgKey: data.encryptedOrgKey,
        orgKeyIv: data.orgKeyIv,
        orgKeyAuthTag: data.orgKeyAuthTag,
        ephemeralPublicKey: data.ephemeralPublicKey,
        hkdfSalt: data.hkdfSalt,
        wrapVersion: data.wrapVersion,
      },
    });

    await tx.orgMember.update({
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
      { error: API_ERROR.ORG_KEY_VERSION_MISMATCH },
      { status: 409 }
    );
  }

  return NextResponse.json({ success: true });
}
