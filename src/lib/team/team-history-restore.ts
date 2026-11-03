import { decryptData, encryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import type { EntryTypeValue } from "@/lib/constants";
import { buildTeamOverviewFromBlob } from "@/lib/team/team-entry-payload";
import { teamEntryAadFor } from "@/lib/team/team-key-resolution";
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
 * The history restore POST body (deviation D1): the row decrypted with its
 * own key, its overview rebuilt from the blob as the save path builds it and
 * encrypted under the restored row's key at the row's overview AAD
 * (itemKeyVersion of the row), so the restored entry's list view opens with
 * the key the entry will then hold.
 */
export async function buildTeamHistoryRestoreBody(
  teamId: string,
  entryId: string,
  row: TeamHistoryRowDto,
  getEntryDecryptionKey: (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<CryptoKey>,
): Promise<{ encryptedOverview: EncryptedData }> {
  const keyData = historyRowKeyData(row);
  const itemKeyVersion = keyData.itemKeyVersion ?? 0;
  const key = await getEntryDecryptionKey(teamId, entryId, keyData);
  const plaintext = await decryptData(
    { ciphertext: row.encryptedBlob, iv: row.blobIv, authTag: row.blobAuthTag },
    key,
    teamEntryAadFor(teamId, entryId, VAULT_TYPE.BLOB, itemKeyVersion, row.aadVersion),
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
    encryptedOverview: await encryptData(
      overview,
      key,
      buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.OVERVIEW, itemKeyVersion),
    ),
  };
}
