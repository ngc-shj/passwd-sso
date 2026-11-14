import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { activeTeamAdmission, hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { logAuditBulkInTx, logAuditInTx, teamAuditBase } from "@/lib/audit/audit";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { teamMemberKeySchema } from "@/lib/validations";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { errorResponse, handleAuthError, rateLimited, unauthorized, validationError } from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { teamRotateKeyFailureLimiter } from "@/lib/security/rate-limiters";
import { ROTATE_CARRY_REASON, TEAM_ROTATE_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import {
  encryptedFieldSchema,
  hexIv,
  TEAM_KEY_VERSION_MIN,
  TEAM_KEY_VERSION_MAX,
  TEAM_ROTATE_ENTRIES_MAX,
  TEAM_ROTATE_MEMBER_KEYS_MIN,
  TEAM_ROTATE_MEMBER_KEYS_MAX,
} from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { heldTeamKeyVersions, normalizeTeamKeyVersion } from "@/lib/team/team-item-key";
import { createLockBudget } from "@/lib/team/team-key-rotation-lock";
import {
  actorDepartedSinceAdmission,
  lockTenantRows,
  readTenantRows,
  TenantMemberLockTimeoutError,
} from "@/lib/team/tenant-row-lock";
import { membershipConflictResponse } from "@/lib/http/lock-conflict-response";

// Counts successful rotations only: the slot check() takes is released by
// clear() when the request ends in anything but a committed rotation (one
// slot per window, so the only counter clear() can reset is this request's).
const teamRotateKeyLimiter = createRateLimiter({ windowMs: 5 * MS_PER_MINUTE, max: 1 });

type Params = { params: Promise<{ teamId: string }> };

/** A rotation refusal raised inside the transaction, answered with its code. */
class RotationRefusal extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
  }
}

class TxValidationError extends Error {
  details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("TX_VALIDATION_ERROR");
    this.details = details;
  }
}

// Each entry carries `snapshotIv`: the IV of the ciphertext the client
// re-encrypted from (the blob's for v0, the wrapped ItemKey's for v1+), taken
// from GET rotate-key/data. The update only applies while the row still holds
// that ciphertext, so a write committed between the snapshot and this
// rotation is not overwritten with re-encryption of stale data.

// v0 (legacy): full re-encrypt of blob + overview. Both ciphertexts are
// replaced, so the snapshot names both IVs.
const rotateEntryV0Schema = z.object({
  id: z.string().uuid(),
  itemKeyVersion: z.literal(0).default(0),
  snapshotIv: hexIv,
  snapshotOverviewIv: hexIv,
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  aadVersion: z.number().int().min(1),
});

// v1+ (ItemKey): only rewrap the ItemKey with new TeamKey
const rotateEntryV1Schema = z.object({
  id: z.string().uuid(),
  itemKeyVersion: z.number().int().min(1),
  snapshotIv: hexIv,
  encryptedItemKey: encryptedFieldSchema,
  aadVersion: z.number().int().min(1),
});

const rotateEntrySchema = z.union([rotateEntryV1Schema, rotateEntryV0Schema]);

// An entry the actor cannot open is carried unchanged: it keeps its
// ciphertext and old team key version and stays pending re-key (plan C3).
const rotateCarrySchema = z.object({
  id: z.string().uuid(),
  teamKeyVersion: z.number().int().min(0).max(TEAM_KEY_VERSION_MAX).optional(),
  reason: z.enum([
    ROTATE_CARRY_REASON.NOT_HELD,
    ROTATE_CARRY_REASON.UNDECRYPTABLE,
    ROTATE_CARRY_REASON.KEY_INVALID,
  ]),
});

const rotateKeySchema = z.object({
  newTeamKeyVersion: z.number().int().min(TEAM_KEY_VERSION_MIN).max(TEAM_KEY_VERSION_MAX),
  entries: z.array(rotateEntrySchema).max(TEAM_ROTATE_ENTRIES_MAX),
  carry: z.array(rotateCarrySchema).max(TEAM_ROTATE_ENTRIES_MAX).default([]),
  memberKeys: z.array(
    z.object({
      userId: z.string().uuid(),
    }).merge(teamMemberKeySchema)
  ).min(TEAM_ROTATE_MEMBER_KEYS_MIN).max(TEAM_ROTATE_MEMBER_KEYS_MAX),
});

// POST /api/teams/[teamId]/rotate-key — Rotate team encryption key
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // @stepup id:team-rotate-key-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  const rateKey = `rl:team_rotate_key:${teamId}`;
  const rl = await teamRotateKeyLimiter.check(rateKey);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);
  // Every attempt takes a failure slot; a committed rotation releases them.
  const failureKey = `rl:team_rotate_key_failure:${teamId}:${session.user.id}`;
  const failures = await teamRotateKeyFailureLimiter.check(failureKey);
  if (!failures.allowed) {
    await teamRotateKeyLimiter.clear(rateKey);
    return rateLimited(failures.retryAfterMs);
  }

  let response: NextResponse | undefined;
  try {
    response = await rotateTeamKey(req, teamId, session.user.id);
    return response;
  } finally {
    // A refusal (or a throw) rotated nothing: release the success slot it
    // took and keep the failure slot.
    if (response?.status === 200) await teamRotateKeyFailureLimiter.clear(failureKey);
    else await teamRotateKeyLimiter.clear(rateKey);
  }
}

async function rotateTeamKey(req: NextRequest, teamId: string, userId: string): Promise<NextResponse> {
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { teamKeyVersion: true, tenantId: true },
    }),
  );

  if (!team) {
    return errorResponse(API_ERROR.TEAM_NOT_FOUND);
  }

  const result = await parseBody(req, rotateKeySchema);
  if (!result.ok) return result.response;

  const { newTeamKeyVersion, entries, carry, memberKeys } = result.data;

  // Validate version increment
  if (newTeamKeyVersion !== team.teamKeyVersion + 1) {
    return errorResponse(API_ERROR.TEAM_KEY_VERSION_MISMATCH, undefined, {
      details: { expected: team.teamKeyVersion + 1 },
    });
  }

  // Interactive transaction with optimistic lock on teamKeyVersion (S-17)
  // Member list verification is inside transaction to prevent TOCTOU (F-26)
  try {
    await withTeamTenantRls(
      teamId,
      async (tenantId, tx) => {
        // The rotating member's tenant row first (tenant-row-lock.ts lock
        // order: tenant rows, then the team): their departure holds it FOR
        // UPDATE, so the authority re-read below sees a departure that
        // committed meanwhile.
        const actorRows = await lockTenantRows(tx, tenantId, [userId], "share", createLockBudget());
        // Re-verify teamKeyVersion hasn't changed since pre-read, under a row
        // lock taken before any team or member write (see team-key-rotation-lock.ts).
        // Entry creates and full updates, history restores, key distribution,
        // and member removal hold this row FOR SHARE, so each has either
        // committed before the member and entry reads below (and is read) or
        // waits for this rotation. NO KEY UPDATE, not UPDATE: it conflicts
        // with those FOR SHARE holders without blocking unrelated inserts
        // whose foreign key to teams takes KEY SHARE.
        const [currentTeam] = await tx.$queryRaw<{ team_key_version: number }[]>`
          SELECT team_key_version FROM teams WHERE id = ${teamId}::uuid FOR NO KEY UPDATE
        `;
        if (!currentTeam || currentTeam.team_key_version !== team.teamKeyVersion) {
          throw new Error("TEAM_KEY_VERSION_CONFLICT");
        }
        // The rotating member's authority, under the team lock: a departure,
        // removal or demotion committed since requireTeamPermission would
        // otherwise rotate the team to a key the actor generated and keeps.
        // A leftover membership (the actor's tenant row departed at or after
        // their admission) is treated as deactivated, which refuses here.
        const actor = await activeTeamAdmission(tx, teamId, userId);
        if (
          !actor ||
          !hasTeamPermission(actor.role, TEAM_PERMISSION.TEAM_UPDATE) ||
          actorDepartedSinceAdmission(actorRows.get(userId), actor.admittedAt)
        ) {
          throw new RotationRefusal(API_ERROR.ACTOR_NOT_PERMITTED);
        }

        // Verify all active members have a key in the payload (F-26: inside
        // tx, after the team lock that member removal also takes)
        const members = await tx.teamMember.findMany({
          where: { teamId: teamId, deactivatedAt: null, keyDistributed: true },
          select: { userId: true, admittedAt: true, createdAt: true },
        });
        // A leftover key-holder (tenant row departed at or after their
        // admission) is treated like a deactivated row: not wrapped the new
        // version, a key supplied for them refused as for a non-member, and
        // listed for distribution below. Their tenant rows are read unlocked:
        // residue is old state, and locking every key-holder's row would
        // serialise rotation with every SCIM write to any of them. A departure
        // in flight takes the team row FOR SHARE, which this rotation's lock
        // excludes, so it deactivates the membership before or after it.
        const tenantRows = await readTenantRows(tx, tenantId, members.map((m) => m.userId));
        const leftoverUserIds = members
          .filter((m) => actorDepartedSinceAdmission(tenantRows.get(m.userId), m.admittedAt ?? m.createdAt))
          .map((m) => m.userId);
        const memberUserIds = new Set(
          members.map((m) => m.userId).filter((id) => !leftoverUserIds.includes(id)),
        );
        for (const memberUserId of memberUserIds) {
          if (!memberKeys.some((k) => k.userId === memberUserId)) {
            throw new TxValidationError({ missingKeyFor: memberUserId });
          }
        }
        // Reject extra memberKeys for non-members (F-18/S-22)
        for (const k of memberKeys) {
          if (!memberUserIds.has(k.userId)) {
            throw new TxValidationError({ unknownUserId: k.userId });
          }
        }

        // Verify submitted entries plus carried entries exactly match ALL
        // team entries (including trash), each id once.
        const allEntries = await tx.teamPasswordEntry.findMany({
          where: { teamId: teamId },
          select: { id: true, teamKeyVersion: true },
        });
        const submittedIds = [...entries.map((e) => e.id), ...carry.map((c) => c.id)];
        const submittedEntryIdSet = new Set(submittedIds);
        if (
          submittedEntryIdSet.size !== submittedIds.length ||
          submittedEntryIdSet.size !== allEntries.length ||
          allEntries.some((e) => !submittedEntryIdSet.has(e.id))
        ) {
          throw new Error("ENTRY_COUNT_MISMATCH");
        }

        // A carry is checked against the entry's own team key version and
        // the actor's member keys: `not_held` only when the actor holds no
        // key at that version, `undecryptable` / `key_invalid` only when it
        // does — so neither stands in for a refused `not_held`.
        const carriedVersions = new Map<string, number>();
        if (carry.length > 0) {
          const entryVersionById = new Map(
            allEntries.map((e) => [e.id, normalizeTeamKeyVersion(e.teamKeyVersion)]),
          );
          const held = new Set(
            (await heldTeamKeyVersions(tx, teamId, userId)).map(normalizeTeamKeyVersion),
          );
          for (const c of carry) {
            const version = entryVersionById.get(c.id);
            if (version === undefined) throw new Error("ENTRY_COUNT_MISMATCH");
            if (c.teamKeyVersion !== undefined && normalizeTeamKeyVersion(c.teamKeyVersion) !== version) {
              throw new RotationRefusal(API_ERROR.TEAM_ROTATE_CARRY_INVALID);
            }
            if (c.reason === ROTATE_CARRY_REASON.NOT_HELD) {
              if (held.has(version)) throw new RotationRefusal(API_ERROR.TEAM_ROTATE_KEY_UNAVAILABLE);
            } else if (!held.has(version)) {
              throw new RotationRefusal(API_ERROR.TEAM_ROTATE_CARRY_INVALID);
            }
            carriedVersions.set(c.id, version);
          }
        }

      // Re-encrypt all entries with new key.
      // updateMany + teamId scope prevents out-of-team updates.
      // teamKeyVersion is NOT in where: entries restored from history may have
      // a stale version, but the ID set verification above guarantees completeness (F-29).
      // The snapshot predicate (itemKeyVersion + the re-encrypted ciphertext's
      // IV — the wrap's for v1+, the blob's and the overview's for v0) rejects
      // an entry changed since the client's snapshot. IVs are random per
      // encryption, so an equal IV means the same ciphertext.
      // Rotation re-wraps the ItemKey and never replaces it: item_key_id, the
      // re-key marker and the high-water are not written here.
      // Note: Prisma interactive transaction auto-rolls back on any thrown error.
        for (const entry of entries) {
          const data: Record<string, unknown> = {
            aadVersion: entry.aadVersion,
            teamKeyVersion: newTeamKeyVersion,
          };
          let snapshot: Record<string, unknown>;

          if (entry.itemKeyVersion >= 1 && "encryptedItemKey" in entry) {
            // ItemKey entry: rewrap ItemKey only
            snapshot = { itemKeyVersion: entry.itemKeyVersion, itemKeyIv: entry.snapshotIv };
            data.encryptedItemKey = entry.encryptedItemKey.ciphertext;
            data.itemKeyIv = entry.encryptedItemKey.iv;
            data.itemKeyAuthTag = entry.encryptedItemKey.authTag;
          } else if ("encryptedBlob" in entry) {
            snapshot = {
              itemKeyVersion: 0,
              blobIv: entry.snapshotIv,
              overviewIv: entry.snapshotOverviewIv,
            };
            // Legacy entry: full re-encrypt
            data.encryptedBlob = entry.encryptedBlob.ciphertext;
            data.blobIv = entry.encryptedBlob.iv;
            data.blobAuthTag = entry.encryptedBlob.authTag;
            data.encryptedOverview = entry.encryptedOverview.ciphertext;
            data.overviewIv = entry.encryptedOverview.iv;
            data.overviewAuthTag = entry.encryptedOverview.authTag;
          } else {
            throw new Error("ENTRY_COUNT_MISMATCH");
          }

          const result = await tx.teamPasswordEntry.updateMany({
            where: {
              id: entry.id,
              teamId: teamId,
              ...snapshot,
            },
            data,
          });
          if (result.count !== 1) {
            throw new Error("ENTRY_COUNT_MISMATCH");
          }
        }

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

      // A deactivated member (left the tenant, or removed by the IdP) or a
      // leftover one was not wrapped the new version: if they come back, they
      // are listed for distribution of it rather than counted as holding it.
        await tx.teamMember.updateMany({
          where: {
            teamId: teamId,
            keyDistributed: true,
            OR: [{ deactivatedAt: { not: null } }, { userId: { in: leftoverUserIds } }],
          },
          data: { keyDistributed: false },
        });

      // Bump team key version
        await tx.team.update({
          where: { id: teamId },
          data: { teamKeyVersion: newTeamKeyVersion },
        });

      // One row per carried entry, committed with the rotation: the carry
      // list can exceed the summary row's metadata cap, and each carry is the
      // actor's own claim about that entry. The summary commits with them.
        await logAuditBulkInTx(
          tx,
          team.tenantId,
          carry.map((c) => ({
            ...teamAuditBase(req, userId, teamId),
            action: AUDIT_ACTION.TEAM_KEY_ROTATION_CARRY,
            targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
            targetId: c.id,
            metadata: { reason: c.reason, teamKeyVersion: carriedVersions.get(c.id) },
          })),
        );
        await logAuditInTx(tx, team.tenantId, {
          ...teamAuditBase(req, userId, teamId),
          action: AUDIT_ACTION.TEAM_KEY_ROTATION,
          targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
          targetId: teamId,
          metadata: {
            fromVersion: team.teamKeyVersion,
            toVersion: newTeamKeyVersion,
            entriesRotated: entries.length,
            entriesCarried: carry.length,
            membersUpdated: memberKeys.length,
          },
        });
      },
      { timeout: TEAM_ROTATE_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (e instanceof Error && e.message === "TEAM_KEY_VERSION_CONFLICT") {
      return errorResponse(API_ERROR.TEAM_KEY_VERSION_MISMATCH);
    }
    if (e instanceof RotationRefusal) {
      return errorResponse(e.code);
    }
    // Concurrent rotations serialise on the teams FOR NO KEY UPDATE above, so the
    // loser normally fails the CAS. A teamMemberKey
    // @@unique([teamId, userId, keyVersion]) collision is still mapped to the
    // same 409 conflict shape rather than a bare 500 — mirrors the personal
    // VaultKey P2002 mapping in rotate-key-server.ts.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return errorResponse(API_ERROR.TEAM_KEY_VERSION_MISMATCH);
    }
    if (e instanceof Error && e.message === "ENTRY_COUNT_MISMATCH") {
      return errorResponse(API_ERROR.ENTRY_COUNT_MISMATCH);
    }
    if (e instanceof TxValidationError) {
      return validationError(e.details);
    }
    // The rotating member's tenant row was held past the lock wait: nothing
    // was rotated.
    if (e instanceof TenantMemberLockTimeoutError) {
      return membershipConflictResponse(e);
    }
    throw e;
  }

  return NextResponse.json({
    success: true,
    teamKeyVersion: newTeamKeyVersion,
  });
}

export const POST = withRequestLog(handlePOST);
