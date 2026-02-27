import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { teamMemberKeySchema } from "@/lib/validations";
import { withUserTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string }> };

class TxValidationError extends Error {
  details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("TX_VALIDATION_ERROR");
    this.details = details;
  }
}

const encryptedFieldSchema = z.object({
  ciphertext: z.string().min(1).max(500_000),
  iv: z.string().length(24),
  authTag: z.string().length(32),
});

const rotateKeySchema = z.object({
  newTeamKeyVersion: z.number().int().min(2).max(10_000),
  entries: z.array(
    z.object({
      id: z.string().min(1),
      encryptedBlob: encryptedFieldSchema,
      encryptedOverview: encryptedFieldSchema,
      aadVersion: z.number().int().min(1),
    })
  ).max(1000),
  memberKeys: z.array(
    z.object({
      userId: z.string().min(1),
    }).merge(teamMemberKeySchema)
  ).min(1).max(1000),
});

// POST /api/teams/[teamId]/rotate-key — Rotate team encryption key
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await withUserTenantRls(session.user.id, async () =>
      requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE),
    );
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const team = await withUserTenantRls(session.user.id, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { teamKeyVersion: true },
    }),
  );

  if (!team) {
    return NextResponse.json({ error: API_ERROR.TEAM_NOT_FOUND }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = rotateKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { newTeamKeyVersion, entries, memberKeys } = parsed.data;

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
    await withUserTenantRls(session.user.id, async () =>
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
          where: { teamId: teamId, deactivatedAt: null },
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
          const result = await tx.teamPasswordEntry.updateMany({
            where: {
              id: entry.id,
              teamId: teamId,
            },
            data: {
              encryptedBlob: entry.encryptedBlob.ciphertext,
              blobIv: entry.encryptedBlob.iv,
              blobAuthTag: entry.encryptedBlob.authTag,
              encryptedOverview: entry.encryptedOverview.ciphertext,
              overviewIv: entry.encryptedOverview.iv,
              overviewAuthTag: entry.encryptedOverview.authTag,
              aadVersion: entry.aadVersion,
              teamKeyVersion: newTeamKeyVersion,
            },
          });
          if (result.count !== 1) {
            throw new Error("ENTRY_COUNT_MISMATCH");
          }
        }));

      // Create new TeamMemberKey for each member (old keys kept for history)
      // No filter needed: member validation above guarantees exact 1:1 match
        await Promise.all(
          memberKeys.map((k) =>
              tx.teamMemberKey.create({
                data: {
                  teamId: teamId,
                  userId: k.userId,
                  encryptedTeamKey: k.encryptedTeamKey,
                  teamKeyIv: k.teamKeyIv,
                  teamKeyAuthTag: k.teamKeyAuthTag,
                  ephemeralPublicKey: k.ephemeralPublicKey,
                  hkdfSalt: k.hkdfSalt,
                  keyVersion: newTeamKeyVersion,
                  wrapVersion: k.wrapVersion,
                },
              })
            )
        );

      // Bump team key version
        await tx.team.update({
          where: { id: teamId },
          data: { teamKeyVersion: newTeamKeyVersion },
        });
      }, { timeout: 60_000 }),
    );
  } catch (e) {
    if (e instanceof Error && e.message === "TEAM_KEY_VERSION_CONFLICT") {
      return NextResponse.json(
        { error: API_ERROR.TEAM_KEY_VERSION_MISMATCH },
        { status: 409 }
      );
    }
    if (e instanceof Error && e.message === "ENTRY_COUNT_MISMATCH") {
      return NextResponse.json(
        { error: API_ERROR.ENTRY_COUNT_MISMATCH },
        { status: 400 }
      );
    }
    if (e instanceof TxValidationError) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: e.details },
        { status: 400 }
      );
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
