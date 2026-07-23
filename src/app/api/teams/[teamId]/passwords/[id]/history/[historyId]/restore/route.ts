import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_METADATA_KEY, TEAM_PERMISSION } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

// POST /api/teams/[teamId]/passwords/[id]/history/[historyId]/restore
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, historyId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // Pre-check only (existence + tenant). The snapshot source is re-read
  // INSIDE the transaction under FOR UPDATE below — this outside-tx row may
  // be stale under concurrent PUTs.
  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: {
        teamId: true,
        tenantId: true,
      },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const history = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntryHistory.findUnique({
      where: { id: historyId },
      select: {
        entryId: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        aadVersion: true,
        teamKeyVersion: true,
        itemKeyVersion: true,
        encryptedItemKey: true,
        itemKeyIv: true,
        itemKeyAuthTag: true,
        changedAt: true,
      },
    }),
  );

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND);
  }

  const restored = await withTeamTenantRls(teamId, async () =>
    prisma.$transaction(async (tx) => {
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
    };
    const [cur] = await tx.$queryRaw<LockedRow[]>`
      SELECT encrypted_blob, blob_iv, blob_auth_tag,
             aad_version, team_key_version, item_key_version,
             encrypted_item_key, item_key_iv, item_key_auth_tag
      FROM team_password_entries
      WHERE id = ${id}::uuid AND team_id = ${teamId}::uuid
      FOR UPDATE
    `;
    // Entry may be concurrently deleted between the pre-check and this lock.
    if (!cur) return false;

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

    // Restore: writes back the history row's blob together with the
    // ItemKey metadata (itemKeyVersion/encryptedItemKey/itemKeyIv/
    // itemKeyAuthTag) it was originally wrapped with, so the restored
    // entry stays internally consistent (old teamKeyVersion <-> the
    // old-TeamKey-wrapped ItemKey). The version-aware client
    // (getEntryDecryptionKey / getItemEncryptionKey) then selects the
    // matching TeamKey version and decrypts directly — no client-side
    // re-encrypt/PUT roundtrip needed.
    await tx.teamPasswordEntry.update({
      where: { id, teamId },
      data: {
        encryptedBlob: history.encryptedBlob,
        blobIv: history.blobIv,
        blobAuthTag: history.blobAuthTag,
        aadVersion: history.aadVersion,
        teamKeyVersion: history.teamKeyVersion,
        itemKeyVersion: history.itemKeyVersion,
        encryptedItemKey: history.encryptedItemKey,
        itemKeyIv: history.itemKeyIv,
        itemKeyAuthTag: history.itemKeyAuthTag,
        updatedById: session.user.id,
      },
    });
    return true;
    }),
  );

  if (!restored) {
    return notFound();
  }

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.ENTRY_HISTORY_RESTORE,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      [AUDIT_METADATA_KEY.HISTORY_ID]: historyId,
      [AUDIT_METADATA_KEY.RESTORED_FROM_CHANGED_AT]: history.changedAt.toISOString(),
    },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
