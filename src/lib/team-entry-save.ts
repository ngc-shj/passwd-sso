import { encryptData } from "@/lib/crypto-client";
import { buildTeamEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
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

  const encryptedBlob = await encryptData(fullBlob, encryptionKey, blobAAD);
  const encryptedOverview = await encryptData(overviewBlob, encryptionKey, overviewAAD);

  const body: Record<string, unknown> = {
    encryptedBlob,
    encryptedOverview,
    aadVersion: AAD_VERSION,
    teamKeyVersion,
    itemKeyVersion,
    tagIds,
  };

  // Send client-generated ID so the server uses the same ID that was bound into the AAD
  if (mode === "create") body.id = entryId;

  if (encryptedItemKey !== undefined) body.encryptedItemKey = encryptedItemKey;
  if (entryType !== undefined) body.entryType = entryType;
  if (teamFolderId !== undefined) body.teamFolderId = teamFolderId;
  if (requireReprompt !== undefined) body.requireReprompt = requireReprompt;
  if (expiresAt !== undefined) body.expiresAt = expiresAt;

  const endpoint = mode === "create"
    ? apiPath.teamPasswords(teamId)
    : apiPath.teamPasswordById(teamId, entryId);
  const method = mode === "create" ? "POST" : "PUT";

  return fetchApi(endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
