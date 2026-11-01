import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { teamMemberKeySchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { lockTeamKeyVersion, TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";

type Params = { params: Promise<{ teamId: string; memberId: string }> };

// POST /api/teams/[teamId]/members/[memberId]/confirm-key
/** The member row no longer matches what the distribution checked. */
class MemberChangedError extends Error {}

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

  // @stepup id:team-confirm-key-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  // Verify target member exists, belongs to this team, is active, and has vault ready
  const targetMember = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findUnique({
      where: { id: memberId },
      select: {
        teamId: true,
        userId: true,
        keyDistributed: true,
        deactivatedAt: true,
      },
    }),
  );

  if (!targetMember || targetMember.teamId !== teamId || targetMember.deactivatedAt !== null) {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  }

  const targetUser = await withBypassRls(prisma, async (tx) =>
    tx.user.findUnique({
      where: { id: targetMember.userId },
      select: { ecdhPublicKey: true },
    }),
  BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP);

  if (!targetUser?.ecdhPublicKey) {
    return errorResponse(API_ERROR.VAULT_NOT_READY);
  }

  // Prevent overwriting an already-distributed key (S-11)
  if (targetMember.keyDistributed) {
    return errorResponse(API_ERROR.KEY_ALREADY_DISTRIBUTED);
  }

  const result = await parseBody(req, teamMemberKeySchema);
  if (!result.ok) return result.response;

  const data = result.data;

  // Atomic check-and-set: re-verify keyDistributed + deactivatedAt + teamKeyVersion inside transaction (S-12/F-16/S-24)
  let distributed;
  try {
    distributed = await withTeamTenantRls(teamId, async () =>
      prisma.$transaction(async (tx) => {
        // Verify keyVersion matches current team key version (F-16), under the
        // team lock rotation serialises on, taken first (lock order: teams
        // before member rows): a distribution racing a rotation that missed
        // this member would otherwise mark them distributed with only the old key.
        const team = await lockTeamKeyVersion(tx, teamId);

        const member = await tx.teamMember.findUnique({
          where: { id: memberId },
          select: { keyDistributed: true, deactivatedAt: true },
        });
        if (!member || member.deactivatedAt !== null) return "member_not_found" as const;
        if (member.keyDistributed) return "already_distributed" as const;

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

        // The check above is a plain read: re-assert it in the write, so a
        // deactivation or distribution committed since then is not
        // overwritten. A miss rolls the key upsert back.
        const marked = await tx.teamMember.updateMany({
          where: { id: memberId, teamId, deactivatedAt: null, keyDistributed: false },
          data: { keyDistributed: true },
        });
        if (marked.count !== 1) throw new MemberChangedError();

        return "success" as const;
      }),
    );
  } catch (e) {
    // The member was deactivated, or received a key, since the check.
    if (e instanceof MemberChangedError) return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
    // A rotation held the team past the lock timeout: the key being
    // distributed is about to be superseded.
    if (!(e instanceof TeamRotationInProgressError)) throw e;
    distributed = "version_mismatch" as const;
  }

  if (distributed === "member_not_found") {
    return errorResponse(API_ERROR.MEMBER_NOT_FOUND);
  }
  if (distributed === "already_distributed") {
    return errorResponse(API_ERROR.KEY_ALREADY_DISTRIBUTED);
  }
  if (distributed === "version_mismatch") {
    return errorResponse(API_ERROR.TEAM_KEY_VERSION_MISMATCH);
  }

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
