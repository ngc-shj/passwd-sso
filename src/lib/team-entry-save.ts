import { buildTeamEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { apiPath } from "@/lib/constants";
import { buildEncryptedEntryBody, submitEntry } from "@/lib/entry-save-core";
import type { EntryTypeValue } from "@/lib/constants";

interface SaveTeamEntryParams {
  mode: "create" | "edit";
  teamId: string;
  entryId: string;
  encryptionKey: CryptoKey;
  teamKeyVersion: number;
  itemKeyVersion: number;
  encryptedItemKey?: { ciphertext: string; iv: string; authTag: string };
  fullBlob: string;
  overviewBlob: string;
  entryType?: EntryTypeValue;
  tagIds: string[];
  teamFolderId?: string | null;
  requireReprompt?: boolean;
  expiresAt?: string | null;
}

export async function saveTeamEntry({
  mode,
  teamId,
  entryId,
  encryptionKey,
  teamKeyVersion,
  itemKeyVersion,
  encryptedItemKey,
  fullBlob,
  overviewBlob,
  entryType,
  tagIds,
  teamFolderId,
  requireReprompt,
  expiresAt,
}: SaveTeamEntryParams): Promise<Response> {
  // Client-side validation: v>=1 requires encryptedItemKey for create/upgrade
  if (itemKeyVersion >= 1 && mode === "create" && !encryptedItemKey) {
    throw new Error("encryptedItemKey is required when itemKeyVersion >= 1");
  }

  const blobAAD = buildTeamEntryAAD(teamId, entryId, "blob", itemKeyVersion);
  const overviewAAD = buildTeamEntryAAD(teamId, entryId, "overview", itemKeyVersion);

  const body = await buildEncryptedEntryBody({
    mode,
    entryId,
    encryptionKey,
    fullBlob,
    overviewBlob,
    blobAAD,
    overviewAAD,
    tagIds,
    extra: {
      aadVersion: AAD_VERSION,
      teamKeyVersion,
      itemKeyVersion,
    },
    optionals: { encryptedItemKey, entryType, teamFolderId, requireReprompt, expiresAt },
  });

  const endpoint = mode === "create"
    ? apiPath.teamPasswords(teamId)
    : apiPath.teamPasswordById(teamId, entryId);
  const method = mode === "create" ? "POST" : "PUT";

  return submitEntry(endpoint, method, body);
}
