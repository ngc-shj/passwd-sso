import { decryptData, encryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import type { EntryTypeValue } from "@/lib/constants";
import { buildTeamOverviewFromBlob } from "@/lib/team/team-entry-payload";
import type { EntryItemKeyData } from "@/lib/team/team-vault-core";

/** GET /api/teams/[teamId]/passwords/[id]/history/[historyId] */
export interface TeamHistoryRowDto {
  id: string;
  entryType: EntryTypeValue;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
  aadVersion: number;
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey: string | null;
  itemKeyIv: string | null;
  itemKeyAuthTag: string | null;
  itemKeyId: string | null;
}

/** The history row's own key material, for getEntryDecryptionKey. */
export function historyRowKeyData(row: TeamHistoryRowDto): EntryItemKeyData {
  return {
    itemKeyVersion: row.itemKeyVersion ?? 0,
    encryptedItemKey: row.encryptedItemKey ?? undefined,
    itemKeyIv: row.itemKeyIv ?? undefined,
    itemKeyAuthTag: row.itemKeyAuthTag ?? undefined,
    itemKeyId: row.itemKeyId,
    teamKeyVersion: row.teamKeyVersion ?? 1,
  };
}

/**
 * Thrown before any decrypt for a history row sealed without AAD
 * (aadVersion < 1): nothing binds such a row to this entry, so re-sealing it
 * would launder a substituted ciphertext into an AAD-bound live entry
 * (S-R3-2). The exit is restoring a more recent version.
 */
export class HistoryRowLegacyError extends Error {
  constructor() {
    super("History row predates entry AAD and cannot be restored");
    this.name = "HistoryRowLegacyError";
  }
}

/** True when a history row carries entry AAD and so may be restored. */
export function isRestorableHistoryRow(row: Pick<TeamHistoryRowDto, "aadVersion">): boolean {
  // A non-numeric aadVersion (a malformed response) is refused too.
  return typeof row.aadVersion === "number" && row.aadVersion >= 1;
}

/**
 * The history restore POST body (deviations D1, D67, D72): the row decrypted
 * with its own key at STRICT entry AAD (a legacy aadVersion-0 row is refused
 * before decrypting — HistoryRowLegacyError), its overview rebuilt from the
 * blob as the save path builds it, and BOTH re-sealed under the restored
 * row's key at the current AAD version and the row's ItemKey version. The
 * server writes them with aadVersion = AAD_VERSION, so a live entry is never
 * at aadVersion 0 and every live-entry reader stays strict.
 * `snapshotBlobIv` names the row decrypted: the server refuses
 * HISTORY_ROW_CHANGED when a re-key rewrote it since.
 */
export async function buildTeamHistoryRestoreBody(
  teamId: string,
  entryId: string,
  row: TeamHistoryRowDto,
  getEntryDecryptionKey: (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<CryptoKey>,
): Promise<{ encryptedBlob: EncryptedData; encryptedOverview: EncryptedData; snapshotBlobIv: string }> {
  if (!isRestorableHistoryRow(row)) throw new HistoryRowLegacyError();
  const keyData = historyRowKeyData(row);
  const itemKeyVersion = keyData.itemKeyVersion ?? 0;
  const key = await getEntryDecryptionKey(teamId, entryId, keyData);
  const plaintext = await decryptData(
    { ciphertext: row.encryptedBlob, iv: row.blobIv, authTag: row.blobAuthTag },
    key,
    buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.BLOB, itemKeyVersion),
  );
  let blob: Record<string, unknown>;
  try {
    blob = JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    // A SyntaxError message embeds part of the input: never let it carry plaintext.
    throw new Error("History blob is not valid JSON");
  }
  const overview = buildTeamOverviewFromBlob(blob, row.entryType);
  return {
    encryptedBlob: await encryptData(
      plaintext,
      key,
      buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.BLOB, itemKeyVersion),
    ),
    encryptedOverview: await encryptData(
      overview,
      key,
      buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.OVERVIEW, itemKeyVersion),
    ),
    snapshotBlobIv: row.blobIv,
  };
}
