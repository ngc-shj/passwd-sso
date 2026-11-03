import type { Prisma } from "@prisma/client";
import { lockTeamKeyVersion } from "@/lib/team/team-key-rotation-lock";

/**
 * Locks for the team attachment writers — upload, migrate, delete
 * (docs/archive/review/team-key-rotation-rekey-plan.md C4, C6): the team row
 * FOR SHARE (serialises with rotation), then the entry FOR SHARE (serialises
 * with entry PUT, restore and re-key, which take it FOR UPDATE, so the
 * ItemKey identity read here stays current until commit), then — migrate and
 * delete — the attachment row FOR UPDATE.
 */

type RawTx = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export type LockedTeamAttachmentEntry = {
  teamKeyVersion: number;
  tenantId: string;
  itemKeyVersion: number;
  itemKeyId: string | null;
};

/**
 * Team row FOR SHARE, then the entry row FOR SHARE, read from the locked rows.
 * Returns null when either row is not visible (deleted, hidden by RLS, or the
 * entry belongs to another team). Throws TeamRotationInProgressError when a
 * rotation holds the team row past the bounded wait.
 *
 * MUST run inside an open transaction.
 */
export async function lockTeamAttachmentEntry(
  tx: RawTx,
  teamId: string,
  entryId: string,
): Promise<LockedTeamAttachmentEntry | null> {
  const team = await lockTeamKeyVersion(tx, teamId);
  if (!team) return null;
  const [entry] = await tx.$queryRaw<{ item_key_version: number; item_key_id: string | null }[]>`
    SELECT item_key_version, item_key_id
      FROM team_password_entries
     WHERE id = ${entryId}::uuid AND team_id = ${teamId}::uuid
     FOR SHARE
  `;
  if (!entry) return null;
  return {
    teamKeyVersion: team.teamKeyVersion,
    tenantId: team.tenantId,
    itemKeyVersion: entry.item_key_version,
    itemKeyId: entry.item_key_id,
  };
}

export type LockedTeamAttachment = {
  filename: string;
  contentType: string;
  sizeBytes: number;
  encryptedData: Uint8Array;
  iv: string;
  authTag: string;
  encryptionMode: number;
  keyVersion: number | null;
};

/**
 * The attachment row FOR UPDATE (after lockTeamAttachmentEntry), scoped to
 * its entry. Returns null when the row is gone or belongs to another entry.
 */
export async function lockTeamAttachmentRow(
  tx: RawTx,
  entryId: string,
  attachmentId: string,
): Promise<LockedTeamAttachment | null> {
  const [row] = await tx.$queryRaw<
    {
      filename: string;
      content_type: string;
      size_bytes: number;
      encrypted_data: Uint8Array;
      iv: string;
      auth_tag: string;
      encryption_mode: number;
      key_version: number | null;
    }[]
  >`
    SELECT filename, content_type, size_bytes, encrypted_data, iv, auth_tag,
           encryption_mode, key_version
      FROM attachments
     WHERE id = ${attachmentId}::uuid AND team_password_entry_id = ${entryId}::uuid
     FOR UPDATE
  `;
  if (!row) return null;
  return {
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    encryptedData: row.encrypted_data,
    iv: row.iv,
    authTag: row.auth_tag,
    encryptionMode: row.encryption_mode,
    keyVersion: row.key_version,
  };
}
