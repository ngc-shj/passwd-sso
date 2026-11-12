import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { activeTeamRole, hasTeamPermission, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { getAttachmentBlobStore } from "@/lib/blob-store";
import { deleteAttachmentBlobs } from "@/lib/blob-store/cleanup";
import { BlobRefInvalidError } from "@/lib/blob-store/object-ref";
import { AUDIT_TARGET_TYPE, TEAM_PERMISSION, AUDIT_ACTION, ATTACHMENT_ENCRYPTION_MODE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, teamBusy, unauthorized } from "@/lib/http/api-response";
import { TeamRotationInProgressError } from "@/lib/team/team-key-rotation-lock";
import { lockTeamAttachmentEntry, lockTeamAttachmentRow } from "@/lib/team/team-attachment-lock";
import { itemKeyIdsMatch, normalizeTeamKeyVersion } from "@/lib/team/team-item-key";

type RouteContext = {
  params: Promise<{ teamId: string; id: string; attachmentId: string }>;
};

/**
 * An ItemKey wrap the client can open the attachment's key with: the entry's
 * own, or a history row's (an attachment written under an ItemKey the entry
 * has since replaced, e.g. by a restore).
 */
type ItemKeyWrap = {
  source: "entry" | "history";
  historyId: string | null;
  encryptedItemKey: string;
  itemKeyIv: string;
  itemKeyAuthTag: string;
  teamKeyVersion: number;
  itemKeyVersion: number;
};

type WrapRow = {
  encryptedItemKey: string | null;
  itemKeyIv: string | null;
  itemKeyAuthTag: string | null;
  teamKeyVersion: number;
  itemKeyVersion: number;
};

function toWrap(row: WrapRow, source: ItemKeyWrap["source"], historyId: string | null): ItemKeyWrap | null {
  if (row.itemKeyVersion < 1 || !row.encryptedItemKey || !row.itemKeyIv || !row.itemKeyAuthTag) {
    return null;
  }
  return {
    source,
    historyId,
    encryptedItemKey: row.encryptedItemKey,
    itemKeyIv: row.itemKeyIv,
    itemKeyAuthTag: row.itemKeyAuthTag,
    teamKeyVersion: row.teamKeyVersion,
    itemKeyVersion: row.itemKeyVersion,
  };
}

// GET /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId] - Download encrypted attachment
async function handleGET(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, attachmentId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_READ, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // The entry, its history wraps and the attachment, read in one transaction.
  const found = await withTeamTenantRls(teamId, async (_tenantId, tx) => {
    const entry = await tx.teamPasswordEntry.findUnique({
      where: { id },
      select: {
        teamId: true,
        encryptedItemKey: true,
        itemKeyIv: true,
        itemKeyAuthTag: true,
        teamKeyVersion: true,
        itemKeyVersion: true,
        itemKeyId: true,
      },
    });
    if (!entry || entry.teamId !== teamId) return null;
    const attachment = await tx.attachment.findUnique({
      where: { id: attachmentId, teamPasswordEntryId: id },
    });
    if (!attachment) return { entry, attachment: null, history: [] };
    const history = attachment.encryptionMode === ATTACHMENT_ENCRYPTION_MODE.VAULT_KEY
      ? []
      : await tx.teamPasswordEntryHistory.findMany({
          where: {
            entryId: id,
            ...(attachment.encryptionMode === ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED &&
            attachment.cekItemKeyId !== null
              ? { itemKeyId: attachment.cekItemKeyId }
              : {}),
          },
          select: {
            id: true,
            encryptedItemKey: true,
            itemKeyIv: true,
            itemKeyAuthTag: true,
            teamKeyVersion: true,
            itemKeyVersion: true,
            itemKeyId: true,
          },
          // Latest team key version first: the wrap a current member is most
          // likely to hold the key for.
          orderBy: [{ teamKeyVersion: "desc" }, { changedAt: "desc" }, { id: "asc" }],
        });
    return { entry, attachment, history };
  });

  if (!found) {
    return notFound();
  }
  const { entry, attachment, history } = found;
  if (!attachment) {
    return errorResponse(API_ERROR.ATTACHMENT_NOT_FOUND);
  }

  // Key material per mode. Mode 2: the one wrap holding the ItemKey the CEK
  // is wrapped under (by item_key_id); none left → 409. Mode 2 bound to no id
  // (migrated on an entry of unknown identity during rollout, D41) and mode 1
  // (legacy): the entry wrap and every history wrap — the client finds the
  // right ItemKey by trial decryption. Mode 0 (legacy): the team key at
  // keyVersion.
  const allWraps = () => {
    const entryWrap = toWrap(entry, "entry", null);
    return [
      ...(entryWrap ? [entryWrap] : []),
      ...history.map((h) => toWrap(h, "history", h.id)).filter((w) => w !== null),
    ];
  };
  const cekWrapFields = () => ({
    keyVersion: attachment.keyVersion,
    cekEncrypted: attachment.cekEncrypted
      ? Buffer.from(attachment.cekEncrypted).toString("base64")
      : null,
    cekIv: attachment.cekIv,
    cekAuthTag: attachment.cekAuthTag,
    cekKeyVersion: attachment.cekKeyVersion,
    cekWrapAadVersion: attachment.cekWrapAadVersion,
  });
  let keyMaterial: Record<string, unknown>;
  if (
    attachment.encryptionMode === ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED &&
    attachment.cekItemKeyId === null
  ) {
    const itemKeyWraps = allWraps();
    if (itemKeyWraps.length === 0) {
      return errorResponse(API_ERROR.ATTACHMENT_KEY_UNAVAILABLE);
    }
    keyMaterial = { ...cekWrapFields(), itemKeyWraps };
  } else if (attachment.encryptionMode === ATTACHMENT_ENCRYPTION_MODE.CEK_WRAPPED) {
    const wrap = itemKeyIdsMatch(entry.itemKeyId, attachment.cekItemKeyId)
      ? toWrap(entry, "entry", null)
      : history
          .filter((h) => itemKeyIdsMatch(h.itemKeyId, attachment.cekItemKeyId))
          .map((h) => toWrap(h, "history", h.id))
          .find((w) => w !== null) ?? null;
    if (!wrap) {
      return errorResponse(API_ERROR.ATTACHMENT_KEY_UNAVAILABLE);
    }
    keyMaterial = { ...cekWrapFields(), itemKeyWrap: wrap };
  } else if (attachment.encryptionMode === ATTACHMENT_ENCRYPTION_MODE.ITEM_KEY) {
    keyMaterial = { keyVersion: attachment.keyVersion, itemKeyWraps: allWraps() };
  } else {
    keyMaterial = { keyVersion: normalizeTeamKeyVersion(attachment.keyVersion ?? 0) };
  }

  // Return encrypted data + crypto metadata for client-side decryption. The
  // storage ref itself is never returned.
  const blobStore = getAttachmentBlobStore();
  let encryptedBuffer: Buffer;
  try {
    encryptedBuffer = await blobStore.getObject(attachment.encryptedData, {
      attachmentId,
      entryId: id,
      teamId,
    });
  } catch (e) {
    if (e instanceof BlobRefInvalidError) return errorResponse(API_ERROR.BLOB_REF_INVALID);
    throw e;
  }

  return NextResponse.json({
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    encryptedData: encryptedBuffer.toString("base64"),
    iv: attachment.iv,
    authTag: attachment.authTag,
    aadVersion: attachment.aadVersion,
    encryptionMode: attachment.encryptionMode,
    ...keyMaterial,
  });
}

type DeleteOutcome =
  | { ok: true; filename: string; stored: Uint8Array }
  | { ok: false; code: ApiErrorCode };

// DELETE /api/teams/[teamId]/passwords/[id]/attachments/[attachmentId] - Delete attachment
async function handleDELETE(
  req: NextRequest,
  { params }: RouteContext
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, attachmentId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  // The row is deleted under team FOR SHARE → entry FOR SHARE → attachment
  // FOR UPDATE (same order as upload and migrate), and the stored ref comes
  // from the locked row, so a migrate committing meanwhile hands over its new
  // object rather than leaving it orphaned. The object is deleted after commit.
  const outcome = await withTeamTenantRls(teamId, async (_tenantId, tx): Promise<DeleteOutcome> => {
    try {
      if (!(await lockTeamAttachmentEntry(tx, teamId, id))) {
        return { ok: false, code: API_ERROR.NOT_FOUND };
      }
    } catch (e) {
      if (e instanceof TeamRotationInProgressError) {
        return { ok: false, code: API_ERROR.TEAM_BUSY };
      }
      throw e;
    }
    // The actor's authority, under the team lock: a removal, departure or
    // demotion committed since requireTeamPermission is seen here.
    const role = await activeTeamRole(tx, teamId, session.user.id);
    if (!role || !hasTeamPermission(role, TEAM_PERMISSION.PASSWORD_DELETE)) {
      return { ok: false, code: API_ERROR.ACTOR_NOT_PERMITTED };
    }
    const row = await lockTeamAttachmentRow(tx, id, attachmentId);
    if (!row) return { ok: false, code: API_ERROR.ATTACHMENT_NOT_FOUND };
    await tx.attachment.delete({
      where: { id: attachmentId, teamPasswordEntryId: id },
    });
    return { ok: true, filename: row.filename, stored: row.encryptedData };
  });

  if (!outcome.ok) {
    if (outcome.code === API_ERROR.TEAM_BUSY) return teamBusy();
    return outcome.code === API_ERROR.NOT_FOUND ? notFound() : errorResponse(outcome.code);
  }

  await deleteAttachmentBlobs([
    { stored: outcome.stored, context: { attachmentId, entryId: id, teamId } },
  ]);

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.ATTACHMENT_DELETE,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachmentId,
    metadata: { filename: outcome.filename, entryId: id },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
