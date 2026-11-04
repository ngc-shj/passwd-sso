import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { activeTeamRole, hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { logAuditInTx, teamAuditBase } from "@/lib/audit/audit";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, TEAM_PERMISSION, ATTACHMENT_ENCRYPTION_MODE } from "@/lib/constants";
import { TEAM_ENTRY_REKEY_TX_TIMEOUT_MS } from "@/lib/constants/team/rotate-key";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { errorResponse, handleAuthError, notFound, rateLimited, unauthorized } from "@/lib/http/api-response";
import { teamEntryRekeyLimiter, teamRekeyReadLimiter } from "@/lib/security/rate-limiters";
import {
  BASE64_RE,
  CEK_WRAP_BASE64_MAX,
  MAX_ATTACHMENTS_PER_ENTRY,
  REKEY_BODY_MAX,
  REKEY_HISTORY_MAX,
  encryptedFieldSchema,
  hexAuthTag,
  hexIv,
} from "@/lib/validations/common";
import { AAD_VERSION, CURRENT_CEK_WRAP_AAD_VERSION } from "@/lib/crypto/crypto-aad";
import { lockTeamKeyVersion, TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";
import { isRekeyPending, itemKeyIvReused, nextItemKeyVersion } from "@/lib/team/team-item-key";
import { assertEntryRekeyConsistent, RekeyConsistencyError } from "@/lib/team/rekey-consistency";

type RouteContext = { params: Promise<{ teamId: string; id: string }> };

// ─── GET: what the pass needs to re-key one entry ──────────────────────────

// GET /api/teams/[teamId]/passwords/[id]/rekey
// The entry, every history row and every attachment's key material (no
// attachment body), with the version the new ItemKey must take.
async function handleGET(req: NextRequest, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const { teamId, id: entryId } = await params;

  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const rl = await teamRekeyReadLimiter.check(`rl:team_entry_rekey_read:${teamId}:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const found = await withTeamTenantRls(teamId, async (_tenantId, tx) => {
    const entry = await tx.teamPasswordEntry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        teamId: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        encryptedOverview: true,
        overviewIv: true,
        overviewAuthTag: true,
        aadVersion: true,
        teamKeyVersion: true,
        itemKeyVersion: true,
        encryptedItemKey: true,
        itemKeyIv: true,
        itemKeyAuthTag: true,
        itemKeyId: true,
        itemKeyTeamKeyVersion: true,
        itemKeyVersionHighWater: true,
      },
    });
    if (!entry || entry.teamId !== teamId) return null;
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { teamKeyVersion: true } });
    if (!team) return null;
    const history = await tx.teamPasswordEntryHistory.findMany({
      where: { entryId },
      select: {
        id: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        aadVersion: true,
        teamKeyVersion: true,
        itemKeyVersion: true,
        encryptedItemKey: true,
        itemKeyIv: true,
        itemKeyAuthTag: true,
        itemKeyId: true,
      },
      orderBy: [{ changedAt: "asc" }, { id: "asc" }],
    });
    const attachments = await tx.attachment.findMany({
      where: { teamPasswordEntryId: entryId },
      select: {
        id: true,
        encryptionMode: true,
        iv: true,
        authTag: true,
        keyVersion: true,
        cekEncrypted: true,
        cekIv: true,
        cekAuthTag: true,
        cekKeyVersion: true,
        cekWrapAadVersion: true,
        cekItemKeyId: true,
      },
      orderBy: { id: "asc" },
    });
    return { entry, teamKeyVersion: team.teamKeyVersion, history, attachments };
  });

  if (!found) {
    return notFound();
  }
  const { entry, teamKeyVersion, history, attachments } = found;

  return NextResponse.json({
    entry: {
      id: entry.id,
      encryptedBlob: entry.encryptedBlob,
      blobIv: entry.blobIv,
      blobAuthTag: entry.blobAuthTag,
      encryptedOverview: entry.encryptedOverview,
      overviewIv: entry.overviewIv,
      overviewAuthTag: entry.overviewAuthTag,
      aadVersion: entry.aadVersion,
      teamKeyVersion: entry.teamKeyVersion,
      itemKeyVersion: entry.itemKeyVersion,
      encryptedItemKey: entry.encryptedItemKey,
      itemKeyIv: entry.itemKeyIv,
      itemKeyAuthTag: entry.itemKeyAuthTag,
      itemKeyId: entry.itemKeyId,
      itemKeyTeamKeyVersion: entry.itemKeyTeamKeyVersion,
    },
    history,
    attachments: attachments.map((a) => ({
      ...a,
      cekEncrypted: a.cekEncrypted ? Buffer.from(a.cekEncrypted).toString("base64") : null,
    })),
    // The version the new ItemKey must take; recomputed under the entry lock.
    nextItemKeyVersion: nextItemKeyVersion(entry.itemKeyVersionHighWater, entry.itemKeyVersion),
    teamKeyVersion,
  });
}

// ─── POST: re-key one entry ────────────────────────────────────────────────

// The client decrypted the entry, its history rows and its attachment CEKs
// with the ItemKeys it holds and re-encrypted them under a new ItemKey,
// wrapped under the current team key (plan C2). `snapshot` names the entry
// state it read; each history row and attachment names the ciphertext IV it
// read. History rows it could not open are listed in `retainHistoryIds` and
// left as they are.
const rekeyHistorySchema = z.object({
  id: z.string().uuid(),
  snapshotBlobIv: hexIv,
  encryptedBlob: encryptedFieldSchema,
}).strict();

const rekeyAttachmentSchema = z.object({
  id: z.string().uuid(),
  snapshotCekIv: hexIv,
  cekEncrypted: z.string().min(1).max(CEK_WRAP_BASE64_MAX).regex(BASE64_RE),
  cekIv: hexIv,
  cekAuthTag: hexAuthTag,
}).strict();

const rekeySchema = z.object({
  teamKeyVersion: z.number().int().min(1),
  snapshot: z.object({
    blobIv: hexIv,
    overviewIv: hexIv,
    itemKeyIv: hexIv,
    itemKeyVersion: z.number().int().min(1),
  }).strict(),
  newItemKeyVersion: z.number().int().min(1),
  encryptedItemKey: encryptedFieldSchema,
  encryptedBlob: encryptedFieldSchema,
  encryptedOverview: encryptedFieldSchema,
  aadVersion: z.literal(AAD_VERSION),
  history: z.array(rekeyHistorySchema).max(REKEY_HISTORY_MAX),
  retainHistoryIds: z.array(z.string().uuid()).max(REKEY_HISTORY_MAX),
  attachmentCekRewraps: z.array(rekeyAttachmentSchema).max(MAX_ATTACHMENTS_PER_ENTRY),
}).strict().superRefine((body, ctx) => {
  // Each history row is either re-keyed or retained, once.
  const historyIds = [...body.history.map((h) => h.id), ...body.retainHistoryIds];
  if (historyIds.length > REKEY_HISTORY_MAX) {
    ctx.addIssue({ code: "custom", path: ["retainHistoryIds"], message: "too many history rows" });
  }
  if (new Set(historyIds.map((id) => id.toLowerCase())).size !== historyIds.length) {
    ctx.addIssue({ code: "custom", path: ["retainHistoryIds"], message: "duplicate history id" });
  }
  const attachmentIds = body.attachmentCekRewraps.map((a) => a.id.toLowerCase());
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    ctx.addIssue({ code: "custom", path: ["attachmentCekRewraps"], message: "duplicate attachment id" });
  }
});

/** A re-key refusal raised inside the transaction (rolls back every write). */
class RekeyRefusal extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
    this.name = "RekeyRefusal";
  }
}

type LockedEntryRow = {
  blob_iv: string;
  overview_iv: string;
  item_key_iv: string | null;
  item_key_version: number;
  item_key_id: string | null;
  item_key_team_key_version: number;
  item_key_version_high_water: number;
};

const sameHex = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

// POST /api/teams/[teamId]/passwords/[id]/rekey
async function handlePOST(req: NextRequest, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const { teamId, id: entryId } = await params;

  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // @stepup id:team-entry-rekey-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req, userId);
  if (stepUpError) return stepUpError;

  const rl = await teamEntryRekeyLimiter.check(`rl:team_entry_rekey:${teamId}:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  // Refusals that need no body, answered before reading up to REKEY_BODY_MAX
  // of it. Advisory only: every one is checked again under the locks below.
  const pre = await withTeamTenantRls(teamId, async (_tenantId, tx) => {
    const entry = await tx.teamPasswordEntry.findUnique({
      where: { id: entryId },
      select: { teamId: true, itemKeyVersion: true, itemKeyId: true, itemKeyTeamKeyVersion: true },
    });
    if (!entry || entry.teamId !== teamId) return null;
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { teamKeyVersion: true } });
    if (!team) return null;
    const legacyAttachments = await tx.attachment.count({
      where: { teamPasswordEntryId: entryId, encryptionMode: { not: ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED } },
    });
    return { entry, teamKeyVersion: team.teamKeyVersion, legacyAttachments };
  });
  if (!pre) {
    return notFound();
  }
  if (!isRekeyPending(pre.entry, pre.teamKeyVersion)) {
    return errorResponse(API_ERROR.REKEY_NOT_PENDING);
  }
  if (pre.entry.itemKeyVersion === 0) {
    return errorResponse(API_ERROR.ENTRY_UPGRADE_REQUIRED);
  }
  if (pre.legacyAttachments > 0) {
    return errorResponse(API_ERROR.REKEY_ATTACHMENTS_UNMIGRATED);
  }

  const parsed = await parseBody(req, rekeySchema, { maxBytes: REKEY_BODY_MAX });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const retainHistoryIds = body.retainHistoryIds.map((id) => id.toLowerCase());

  let itemKeyVersion: number;
  try {
    itemKeyVersion = await withTeamTenantRls(
      teamId,
      async (tenantId, tx) => {
        // Lock order: team FOR SHARE (serialises with rotation, member removal
        // and departure) → entry FOR UPDATE (serialises with PUT, restore and
        // the attachment writers) → its history and attachment rows.
        let team: Awaited<ReturnType<typeof lockTeamKeyVersion>>;
        try {
          team = await lockTeamKeyVersion(tx, teamId);
        } catch (e) {
          if (e instanceof TeamRotationInProgressError) {
            throw new RekeyRefusal(API_ERROR.TEAM_KEY_VERSION_MISMATCH);
          }
          throw e;
        }
        if (!team) throw new RekeyRefusal(API_ERROR.NOT_FOUND);

        const [cur] = await tx.$queryRaw<LockedEntryRow[]>`
          SELECT blob_iv, overview_iv, item_key_iv, item_key_version, item_key_id,
                 item_key_team_key_version, item_key_version_high_water
            FROM team_password_entries
           WHERE id = ${entryId}::uuid AND team_id = ${teamId}::uuid
           FOR UPDATE
        `;
        if (!cur) throw new RekeyRefusal(API_ERROR.NOT_FOUND);

        // The actor's authority, under the team lock: a removal or demotion
        // committed since requireTeamPermission would otherwise still let them
        // rewrite the entry.
        const role = await activeTeamRole(tx, teamId, userId);
        if (!role || !hasTeamPermission(role, TEAM_PERMISSION.TEAM_UPDATE)) {
          throw new RekeyRefusal(API_ERROR.ACTOR_NOT_PERMITTED);
        }

        if (
          !isRekeyPending(
            {
              itemKeyVersion: cur.item_key_version,
              itemKeyId: cur.item_key_id,
              itemKeyTeamKeyVersion: cur.item_key_team_key_version,
            },
            team.teamKeyVersion,
          )
        ) {
          throw new RekeyRefusal(API_ERROR.REKEY_NOT_PENDING);
        }
        if (body.teamKeyVersion !== team.teamKeyVersion) {
          throw new RekeyRefusal(API_ERROR.TEAM_KEY_VERSION_CHANGED);
        }
        // A restore that turned the entry back to v0 since the pre-check.
        if (cur.item_key_version === 0) {
          throw new RekeyRefusal(API_ERROR.ENTRY_UPGRADE_REQUIRED);
        }
        if (
          !sameHex(cur.blob_iv, body.snapshot.blobIv) ||
          !sameHex(cur.overview_iv, body.snapshot.overviewIv) ||
          !sameHex(cur.item_key_iv, body.snapshot.itemKeyIv) ||
          cur.item_key_version !== body.snapshot.itemKeyVersion
        ) {
          throw new RekeyRefusal(API_ERROR.REKEY_SNAPSHOT_MISMATCH);
        }
        const newItemKeyVersion = nextItemKeyVersion(cur.item_key_version_high_water, cur.item_key_version);
        if (body.newItemKeyVersion !== newItemKeyVersion) {
          throw new RekeyRefusal(API_ERROR.ITEM_KEY_VERSION_INVALID);
        }
        if (await itemKeyIvReused(tx, entryId, cur.item_key_iv, body.encryptedItemKey.iv)) {
          throw new RekeyRefusal(API_ERROR.ITEM_KEY_IV_REUSED);
        }

        // The rows the body must name exactly, locked so a trim, purge or
        // upload cannot change the set between this check and the writes.
        const lockedHistory = await tx.$queryRaw<
          { id: string; team_key_version: number; item_key_version: number }[]
        >`
          SELECT id, team_key_version, item_key_version
            FROM team_password_entry_histories
           WHERE entry_id = ${entryId}::uuid
           ORDER BY id
           FOR UPDATE
        `;
        const lockedAttachments = await tx.$queryRaw<{ id: string; encryption_mode: number }[]>`
          SELECT id, encryption_mode
            FROM attachments
           WHERE team_password_entry_id = ${entryId}::uuid
           ORDER BY id
           FOR UPDATE
        `;
        const namedHistory = [...body.history.map((h) => h.id), ...retainHistoryIds];
        if (!sameIdSet(lockedHistory.map((h) => h.id), namedHistory)) {
          throw new RekeyRefusal(API_ERROR.REKEY_SET_MISMATCH);
        }
        // Checked before the attachment set: a legacy attachment has no CEK
        // the client could have re-wrapped, so it is never in the body's set.
        if (lockedAttachments.some((a) => a.encryption_mode !== ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED)) {
          throw new RekeyRefusal(API_ERROR.REKEY_ATTACHMENTS_UNMIGRATED);
        }
        if (!sameIdSet(lockedAttachments.map((a) => a.id), body.attachmentCekRewraps.map((a) => a.id))) {
          throw new RekeyRefusal(API_ERROR.REKEY_SET_MISMATCH);
        }

        // The new ItemKey: its identity is minted here, never taken from the
        // client. History rows and CEKs re-keyed under it carry the same id.
        const newItemKeyId = crypto.randomUUID();
        const wrap = {
          encryptedItemKey: body.encryptedItemKey.ciphertext,
          itemKeyIv: body.encryptedItemKey.iv,
          itemKeyAuthTag: body.encryptedItemKey.authTag,
        };

        for (const h of body.history) {
          const updated = await tx.teamPasswordEntryHistory.updateMany({
            where: { id: h.id, entryId, blobIv: h.snapshotBlobIv },
            data: {
              encryptedBlob: h.encryptedBlob.ciphertext,
              blobIv: h.encryptedBlob.iv,
              blobAuthTag: h.encryptedBlob.authTag,
              aadVersion: body.aadVersion,
              teamKeyVersion: team.teamKeyVersion,
              itemKeyVersion: newItemKeyVersion,
              ...wrap,
              itemKeyId: newItemKeyId,
            },
          });
          if (updated.count !== 1) throw new RekeyRefusal(API_ERROR.REKEY_SNAPSHOT_MISMATCH);
        }

        for (const a of body.attachmentCekRewraps) {
          const updated = await tx.attachment.updateMany({
            where: { id: a.id, teamPasswordEntryId: entryId, encryptionMode: ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED, cekIv: a.snapshotCekIv },
            data: {
              cekEncrypted: Buffer.from(a.cekEncrypted, "base64"),
              cekIv: a.cekIv,
              cekAuthTag: a.cekAuthTag,
              cekKeyVersion: newItemKeyVersion,
              cekWrapAadVersion: CURRENT_CEK_WRAP_AAD_VERSION,
              keyVersion: team.teamKeyVersion,
              cekItemKeyId: newItemKeyId,
            },
          });
          if (updated.count !== 1) throw new RekeyRefusal(API_ERROR.REKEY_SNAPSHOT_MISMATCH);
        }

        await tx.teamPasswordEntry.update({
          where: { id: entryId, teamId },
          data: {
            encryptedBlob: body.encryptedBlob.ciphertext,
            blobIv: body.encryptedBlob.iv,
            blobAuthTag: body.encryptedBlob.authTag,
            encryptedOverview: body.encryptedOverview.ciphertext,
            overviewIv: body.encryptedOverview.iv,
            overviewAuthTag: body.encryptedOverview.authTag,
            aadVersion: body.aadVersion,
            teamKeyVersion: team.teamKeyVersion,
            itemKeyVersion: newItemKeyVersion,
            ...wrap,
            itemKeyId: newItemKeyId,
            itemKeyTeamKeyVersion: team.teamKeyVersion,
            itemKeyVersionHighWater: newItemKeyVersion,
          },
        });

        // Fail-closed verification gate: the rows as written, re-read.
        await assertEntryRekeyConsistent(tx, entryId, retainHistoryIds);

        const retainedIds = new Set(retainHistoryIds);
        await logAuditInTx(tx, tenantId, {
          ...teamAuditBase(req, userId, teamId),
          action: AUDIT_ACTION.TEAM_ENTRY_REKEY,
          targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
          targetId: entryId,
          metadata: {
            fromItemKeyVersion: cur.item_key_version,
            toItemKeyVersion: newItemKeyVersion,
            fromTeamKeyVersion: cur.item_key_team_key_version,
            toTeamKeyVersion: team.teamKeyVersion,
            // Bounded by REKEY_HISTORY_MAX, well inside the metadata cap.
            retained: lockedHistory
              .filter((h) => retainedIds.has(h.id.toLowerCase()))
              .map((h) => ({ id: h.id, teamKeyVersion: h.team_key_version, itemKeyVersion: h.item_key_version })),
          },
        });
        return newItemKeyVersion;
      },
      { timeout: TEAM_ENTRY_REKEY_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (e instanceof RekeyRefusal) {
      return e.code === API_ERROR.NOT_FOUND ? notFound() : errorResponse(e.code);
    }
    if (e instanceof RekeyConsistencyError) {
      getLogger().error({ teamId, entryId, error: errorLogFields(e) }, "teams.entry_rekey.postcheck_failed");
      return errorResponse(API_ERROR.REKEY_POSTCHECK_FAILED);
    }
    throw e;
  }

  return NextResponse.json({ success: true, itemKeyVersion });
}

/** Two id lists name the same set (ids compared case-insensitively). */
function sameIdSet(locked: readonly string[], named: readonly string[]): boolean {
  if (locked.length !== named.length) return false;
  const lockedSet = new Set(locked.map((id) => id.toLowerCase()));
  return named.every((id) => lockedSet.has(id.toLowerCase()));
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
