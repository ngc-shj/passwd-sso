import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/team-auth";
import { teamMemberKeySchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

// POST /api/teams/[teamId]/members/[memberId]/confirm-key
// Admin distributes the team key to a member by encrypting it with member's ECDH public key
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, memberId } = await params;

  // Only OWNER/ADMIN can distribute keys (mapped to MEMBER_INVITE permission)
  try {
    await requireTeamPermission(
        session.user.id,
        teamId,
        TEAM_PERMISSION.MEMBER_INVITE,
        req
      );
  } catch (e) {
    return handleAuthError(e);
  }

  // Verify target member exists, belongs to this team, is active, and has vault ready
  const targetMember = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findUnique({
      where: { id: memberId },
      select: {
        teamId: true,
        userId: true,
        keyDistributed: true,
        deactivatedAt: true,
        user: { select: { ecdhPublicKey: true } },
      },
    }),
  );

  if (!targetMember || targetMember.teamId !== teamId || targetMember.deactivatedAt !== null) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND, 404);
  }

  if (!targetMember.user?.ecdhPublicKey) {
    return errorResponse(API_ERROR.VAULT_NOT_READY, 409);
  }

  // Prevent overwriting an already-distributed key (S-11)
  if (targetMember.keyDistributed) {
    return errorResponse(API_ERROR.KEY_ALREADY_DISTRIBUTED, 409);
  }

  const result = await parseBody(req, teamMemberKeySchema);
  if (!result.ok) return result.response;

  const data = result.data;

  // Atomic check-and-set: re-verify keyDistributed + deactivatedAt + teamKeyVersion inside transaction (S-12/F-16/S-24)
  const distributed = await withTeamTenantRls(teamId, async () =>
    prisma.$transaction(async (tx) => {
      const member = await tx.teamMember.findUnique({
        where: { id: memberId },
        select: { keyDistributed: true, deactivatedAt: true },
      });
      if (!member || member.deactivatedAt !== null) return "member_not_found" as const;
      if (member.keyDistributed) return "already_distributed" as const;

      // Verify keyVersion matches current team key version (F-16)
      const team = await tx.team.findUnique({
        where: { id: teamId },
        select: { teamKeyVersion: true, tenantId: true },
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
          tenantId: team.tenantId,
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
    }),
  );

  if (distributed === "member_not_found") {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND, 404);
  }
  if (distributed === "already_distributed") {
    return errorResponse(API_ERROR.KEY_ALREADY_DISTRIBUTED, 409);
  }
  if (distributed === "version_mismatch") {
    return errorResponse(API_ERROR.TEAM_KEY_VERSION_MISMATCH, 409);
  }

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
