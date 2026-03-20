import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { assertOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { teamMemberKeySchema } from "@/lib/validations";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import {
  encryptedFieldSchema,
  TEAM_KEY_VERSION_MIN,
  TEAM_KEY_VERSION_MAX,
  TEAM_ROTATE_ENTRIES_MAX,
  TEAM_ROTATE_MEMBER_KEYS_MIN,
  TEAM_ROTATE_MEMBER_KEYS_MAX,
} from "@/lib/validations/common";

type Params = { params: Promise<{ teamId: string }> };

class TxValidationError extends Error {
  details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("TX_VALIDATION_ERROR");
    this.details = details;
  }
}

// v0 (legacy): full re-encrypt of blob + overview
const rotateEntryV0Schema = z.object({
  id: z.string().min(1),
  itemKeyVersion: z.literal(0).default(0),
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  aadVersion: z.number().int().min(1),
});

// v1+ (ItemKey): only rewrap the ItemKey with new TeamKey
const rotateEntryV1Schema = z.object({
  id: z.string().min(1),
  itemKeyVersion: z.number().int().min(1),
  encryptedItemKey: encryptedFieldSchema,
  aadVersion: z.number().int().min(1),
});

const rotateEntrySchema = z.union([rotateEntryV1Schema, rotateEntryV0Schema]);

const rotateKeySchema = z.object({
  newTeamKeyVersion: z.number().int().min(TEAM_KEY_VERSION_MIN).max(TEAM_KEY_VERSION_MAX),
  entries: z.array(rotateEntrySchema).max(TEAM_ROTATE_ENTRIES_MAX),
  memberKeys: z.array(
    z.object({
      userId: z.string().min(1),
    }).merge(teamMemberKeySchema)
  ).min(TEAM_ROTATE_MEMBER_KEYS_MIN).max(TEAM_ROTATE_MEMBER_KEYS_MAX),
});

// POST /api/teams/[teamId]/rotate-key — Rotate team encryption key
async function handlePOST(req: NextRequest, { params }: Params) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { teamKeyVersion: true, tenantId: true },
    }),
  );

  if (!team) {
    return errorResponse(API_ERROR.TEAM_NOT_FOUND, 404);
  }

  const result = await parseBody(req, rotateKeySchema);
  if (!result.ok) return result.response;

  const { newTeamKeyVersion, entries, memberKeys } = result.data;

  // Validate version increment
  if (newTeamKeyVersion !== team.teamKeyVersion + 1) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: { expected: team.teamKeyVersion + 1 } },
      { status: 409 }
    );
  }

  // Interactive transaction with optimistic lock on teamKeyVersion (S-17)
  // Member list verification is inside transaction to prevent TOCTOU (F-26)
  try {
    await withTeamTenantRls(teamId, async () =>
      prisma.$transaction(async (tx) => {
        // Re-verify teamKeyVersion hasn't changed since pre-read
        const currentTeam = await tx.team.findUnique({
          where: { id: teamId },
          select: { teamKeyVersion: true },
        });
        if (!currentTeam || currentTeam.teamKeyVersion !== team.teamKeyVersion) {
          throw new Error("TEAM_KEY_VERSION_CONFLICT");
        }

        // Verify all active members have a key in the payload (F-26: inside tx)
        const members = await tx.teamMember.findMany({
          where: { teamId: teamId, deactivatedAt: null, keyDistributed: true },
          select: { userId: true },
        });
        const memberUserIds = new Set(members.map((m) => m.userId));
        for (const userId of memberUserIds) {
          if (!memberKeys.some((k) => k.userId === userId)) {
            throw new TxValidationError({ missingKeyFor: userId });
          }
        }
        // Reject extra memberKeys for non-members (F-18/S-22)
        for (const k of memberKeys) {
          if (!memberUserIds.has(k.userId)) {
            throw new TxValidationError({ unknownUserId: k.userId });
          }
        }

        // Verify submitted entries exactly match ALL team entries (including trash)
        const allEntries = await tx.teamPasswordEntry.findMany({
          where: { teamId: teamId },
          select: { id: true },
        });
        if (entries.length !== allEntries.length) {
          throw new Error("ENTRY_COUNT_MISMATCH");
        }
        const allEntryIdSet = new Set(allEntries.map((e) => e.id));
        const submittedEntryIdSet = new Set(entries.map((e) => e.id));
        if (
          submittedEntryIdSet.size !== entries.length ||
          submittedEntryIdSet.size !== allEntryIdSet.size
        ) {
          throw new Error("ENTRY_COUNT_MISMATCH");
        }
        for (const entryId of submittedEntryIdSet) {
          if (!allEntryIdSet.has(entryId)) {
            throw new Error("ENTRY_COUNT_MISMATCH");
          }
        }

      // Re-encrypt all entries with new key.
      // updateMany + teamId scope prevents out-of-team updates.
      // teamKeyVersion is NOT in where: entries restored from history may have
      // a stale version, but the ID set verification above guarantees completeness (F-29).
      // Note: Prisma interactive transaction auto-rolls back on any thrown error.
        await Promise.all(entries.map(async (entry) => {
          const data: Record<string, unknown> = {
            aadVersion: entry.aadVersion,
            teamKeyVersion: newTeamKeyVersion,
          };

          if (entry.itemKeyVersion >= 1 && "encryptedItemKey" in entry) {
            // ItemKey entry: rewrap ItemKey only
            data.encryptedItemKey = entry.encryptedItemKey.ciphertext;
            data.itemKeyIv = entry.encryptedItemKey.iv;
            data.itemKeyAuthTag = entry.encryptedItemKey.authTag;
          } else if ("encryptedBlob" in entry) {
            // Legacy entry: full re-encrypt
            data.encryptedBlob = entry.encryptedBlob.ciphertext;
            data.blobIv = entry.encryptedBlob.iv;
            data.blobAuthTag = entry.encryptedBlob.authTag;
            data.encryptedOverview = entry.encryptedOverview.ciphertext;
            data.overviewIv = entry.encryptedOverview.iv;
            data.overviewAuthTag = entry.encryptedOverview.authTag;
          }

          const result = await tx.teamPasswordEntry.updateMany({
            where: {
              id: entry.id,
              teamId: teamId,
            },
            data,
          });
          if (result.count !== 1) {
            throw new Error("ENTRY_COUNT_MISMATCH");
          }
        }));

      // Create new TeamMemberKey for each member (old keys kept for history)
      // No filter needed: member validation above guarantees exact 1:1 match
        const createResult = await tx.teamMemberKey.createMany({
          data: memberKeys.map((k) => ({
            teamId: teamId,
            tenantId: team.tenantId,
            userId: k.userId,
            encryptedTeamKey: k.encryptedTeamKey,
            teamKeyIv: k.teamKeyIv,
            teamKeyAuthTag: k.teamKeyAuthTag,
            ephemeralPublicKey: k.ephemeralPublicKey,
            hkdfSalt: k.hkdfSalt,
            keyVersion: newTeamKeyVersion,
            wrapVersion: k.wrapVersion,
          })),
        });
        if (createResult.count !== memberKeys.length) {
          throw new Error("ENTRY_COUNT_MISMATCH");
        }

      // Bump team key version
        await tx.team.update({
          where: { id: teamId },
          data: { teamKeyVersion: newTeamKeyVersion },
        });
      }, { timeout: 60_000 }),
    );
  } catch (e) {
    if (e instanceof Error && e.message === "TEAM_KEY_VERSION_CONFLICT") {
      return errorResponse(API_ERROR.TEAM_KEY_VERSION_MISMATCH, 409);
    }
    if (e instanceof Error && e.message === "ENTRY_COUNT_MISMATCH") {
      return errorResponse(API_ERROR.ENTRY_COUNT_MISMATCH, 400);
    }
    if (e instanceof TxValidationError) {
      return validationError(e.details);
    }
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.TEAM_KEY_ROTATION,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: teamId,
    metadata: {
      fromVersion: team.teamKeyVersion,
      toVersion: newTeamKeyVersion,
      entriesRotated: entries.length,
      membersUpdated: memberKeys.length,
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({
    success: true,
    teamKeyVersion: newTeamKeyVersion,
  });
}

export const POST = withRequestLog(handlePOST);
