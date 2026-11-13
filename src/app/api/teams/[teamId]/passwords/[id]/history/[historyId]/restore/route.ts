import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { activeTeamRole, canWriteTeamEntry, hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_METADATA_KEY, TEAM_PERMISSION } from "@/lib/constants";
import { AAD_VERSION } from "@/lib/crypto/crypto-aad";
import { restoreTeamHistorySchema } from "@/lib/validations";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, teamBusy, unauthorized } from "@/lib/http/api-response";
import { lockTeamKeyVersion, TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";
import { itemKeyIdsMatch, teamKeyVersionHolders } from "@/lib/team/team-item-key";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

type RestoreOutcome =
  | { ok: true; restoredFromChangedAt: Date }
  | { ok: false; code: ApiErrorCode };

// POST /api/teams/[teamId]/passwords/[id]/history/[historyId]/restore
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, historyId } = await params;

  let membership;
  try {
    membership = await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // Pre-check only (existence, tenant, own-entry rule). The entry and the
  // history row are re-read INSIDE the transaction below, under the locks —
  // these outside-tx rows may be stale under concurrent writers.
  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: {
        teamId: true,
        tenantId: true,
        createdById: true,
      },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }
  if (!canWriteTeamEntry(membership.role, entry.createdById, session.user.id)) {
    return errorResponse(API_ERROR.ONLY_OWN_ENTRIES);
  }

  const history = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntryHistory.findUnique({
      where: { id: historyId },
      select: { entryId: true },
    }),
  );

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND);
  }

  const body = await parseBody(req, restoreTeamHistorySchema);
  if (!body.ok) return body.response;
  const { encryptedBlob, encryptedOverview, snapshotBlobIv } = body.data;

  const outcome = await withTeamTenantRls(teamId, async () =>
    prisma.$transaction(async (tx): Promise<RestoreOutcome> => {
    // Lock order: teams FOR SHARE (serialises with rotation, member removal
    // and departure, so the holder check below reads a settled member set),
    // then the entry FOR UPDATE, then the history row.
    try {
      if (!(await lockTeamKeyVersion(tx, teamId))) return { ok: false, code: API_ERROR.NOT_FOUND };
    } catch (e) {
      if (e instanceof TeamRotationInProgressError) {
        return { ok: false, code: API_ERROR.TEAM_BUSY };
      }
      throw e;
    }
    // The actor's authority, under the team lock: a removal, departure or
    // demotion committed since requireTeamPermission is seen here.
    const role = await activeTeamRole(tx, teamId, session.user.id);
    if (!role || !hasTeamPermission(role, TEAM_PERMISSION.PASSWORD_UPDATE)) {
      return { ok: false, code: API_ERROR.ACTOR_NOT_PERMITTED };
    }

    // Row-lock the entry and snapshot from the LOCKED row, not the
    // outside-tx read above — a concurrent PUT committing between that read
    // and this transaction would otherwise have its new content overwritten
    // by the restore while the stale pre-PUT content lands in the snapshot,
    // losing the concurrent write entirely. FOR UPDATE serialises restores
    // and PUTs on the same row (same pattern as team-password-service's
    // full-update snapshot).
    type LockedRow = {
      encrypted_blob: string;
      blob_iv: string;
      blob_auth_tag: string;
      aad_version: number;
      team_key_version: number;
      item_key_version: number;
      encrypted_item_key: string | null;
      item_key_iv: string | null;
      item_key_auth_tag: string | null;
      item_key_id: string | null;
      item_key_team_key_version: number;
      item_key_version_high_water: number;
      created_by_id: string;
    };
    const [cur] = await tx.$queryRaw<LockedRow[]>`
      SELECT encrypted_blob, blob_iv, blob_auth_tag,
             aad_version, team_key_version, item_key_version,
             encrypted_item_key, item_key_iv, item_key_auth_tag,
             item_key_id, item_key_team_key_version, item_key_version_high_water,
             created_by_id
      FROM team_password_entries
      WHERE id = ${id}::uuid AND team_id = ${teamId}::uuid
      FOR UPDATE
    `;
    // Entry may be concurrently deleted between the pre-check and this lock.
    if (!cur) return { ok: false, code: API_ERROR.NOT_FOUND };
    // A MEMBER restores only an entry they created (as the full-update PUT),
    // read from the locked row.
    if (!canWriteTeamEntry(role, cur.created_by_id, session.user.id)) {
      return { ok: false, code: API_ERROR.ACTOR_NOT_PERMITTED };
    }

    // The restore source, read under the entry lock (a re-key or trim
    // committed since the pre-check is seen here).
    const row = await tx.teamPasswordEntryHistory.findUnique({ where: { id: historyId } });
    if (!row || row.entryId !== id) return { ok: false, code: API_ERROR.HISTORY_NOT_FOUND };
    // The client sealed the blob and overview under the key of the row it
    // decrypted; a re-key committed since rewrote the row under a new ItemKey,
    // and restoring those ciphertexts would leave the entry unopenable.
    if (row.blobIv.toLowerCase() !== snapshotBlobIv.toLowerCase()) {
      return { ok: false, code: API_ERROR.HISTORY_ROW_CHANGED };
    }

    // A row whose team key version no active member holds cannot be opened
    // by anyone: restoring it would leave the entry unreadable.
    if ((await teamKeyVersionHolders(tx, teamId, row.teamKeyVersion)).length === 0) {
      return { ok: false, code: API_ERROR.HISTORY_KEY_UNAVAILABLE };
    }

    // A legacy (aadVersion 0) row is sealed without AAD, so nothing binds it
    // to this entry: restoring it would launder a substituted ciphertext into
    // an AAD-bound live entry (S-R3-2). The client refuses it before
    // decrypting; this is the honest server's half.
    if (row.aadVersion < 1) {
      return { ok: false, code: API_ERROR.HISTORY_ROW_LEGACY };
    }

    // ItemKey identity and re-key marker (plan C1): restoring the live
    // ItemKey keeps the marker; any other ItemKey leaves the entry pending.
    // A v0 row has no ItemKey; a v1+ row of unknown identity gets a new one.
    const sameItemKey = itemKeyIdsMatch(row.itemKeyId, cur.item_key_id);
    const itemKeyId = sameItemKey
      ? cur.item_key_id
      : row.itemKeyVersion === 0
        ? null
        : (row.itemKeyId ?? crypto.randomUUID());
    const itemKeyTeamKeyVersion = sameItemKey ? cur.item_key_team_key_version : 0;

    // Snapshot current (from the locked row)
    await tx.teamPasswordEntryHistory.create({
      data: {
        entryId: id,
        tenantId: entry.tenantId,
        encryptedBlob: cur.encrypted_blob,
        blobIv: cur.blob_iv,
        blobAuthTag: cur.blob_auth_tag,
        aadVersion: cur.aad_version,
        teamKeyVersion: cur.team_key_version,
        itemKeyVersion: cur.item_key_version,
        encryptedItemKey: cur.encrypted_item_key,
        itemKeyIv: cur.item_key_iv,
        itemKeyAuthTag: cur.item_key_auth_tag,
        itemKeyId: cur.item_key_id,
        changedById: session.user.id,
      },
    });

    // Trim to max 20
    const all = await tx.teamPasswordEntryHistory.findMany({
      where: { entryId: id },
      orderBy: [{ changedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (all.length > 20) {
      await tx.teamPasswordEntryHistory.deleteMany({
        where: { entryId: id, id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
      });
    }

    // Restore: writes the client's blob and overview — the row's content
    // re-sealed under the row's key at the current AAD version — together
    // with the ItemKey metadata (itemKeyVersion/encryptedItemKey/itemKeyIv/
    // itemKeyAuthTag) the row was wrapped with, so the restored entry stays
    // internally consistent (old teamKeyVersion <-> the old-TeamKey-wrapped
    // ItemKey). The version-aware client (getEntryDecryptionKey /
    // getItemEncryptionKey) then selects the matching TeamKey version. The
    // row's aadVersion is never copied: a live entry is always at
    // AAD_VERSION, and every live-entry reader is strict (D67).
    await tx.teamPasswordEntry.update({
      where: { id, teamId },
      data: {
        encryptedBlob: encryptedBlob.ciphertext,
        blobIv: encryptedBlob.iv,
        blobAuthTag: encryptedBlob.authTag,
        encryptedOverview: encryptedOverview.ciphertext,
        overviewIv: encryptedOverview.iv,
        overviewAuthTag: encryptedOverview.authTag,
        aadVersion: AAD_VERSION,
        teamKeyVersion: row.teamKeyVersion,
        itemKeyVersion: row.itemKeyVersion,
        encryptedItemKey: row.encryptedItemKey,
        itemKeyIv: row.itemKeyIv,
        itemKeyAuthTag: row.itemKeyAuthTag,
        itemKeyId,
        itemKeyTeamKeyVersion,
        itemKeyVersionHighWater: Math.max(cur.item_key_version_high_water, row.itemKeyVersion),
        updatedById: session.user.id,
      },
    });
    return { ok: true, restoredFromChangedAt: row.changedAt };
    }),
  );

  if (!outcome.ok) {
    if (outcome.code === API_ERROR.TEAM_BUSY) return teamBusy();
    return outcome.code === API_ERROR.NOT_FOUND ? notFound() : errorResponse(outcome.code);
  }

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.ENTRY_HISTORY_RESTORE,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      [AUDIT_METADATA_KEY.HISTORY_ID]: historyId,
      [AUDIT_METADATA_KEY.RESTORED_FROM_CHANGED_AT]: outcome.restoredFromChangedAt.toISOString(),
    },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
