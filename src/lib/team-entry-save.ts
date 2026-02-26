import { encryptData } from "@/lib/crypto-client";
import { buildTeamEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

interface SaveTeamEntryParams {
  mode: "create" | "edit";
  teamId: string;
  initialId?: string;
  teamEncryptionKey: CryptoKey;
  teamKeyVersion: number;
  fullBlob: string;
  overviewBlob: string;
  entryType?: EntryTypeValue;
  tagIds: string[];
  teamFolderId?: string | null;
}

export async function saveTeamEntry({
  mode,
  teamId,
  initialId,
  teamEncryptionKey,
  teamKeyVersion,
  fullBlob,
  overviewBlob,
  entryType,
  tagIds,
  teamFolderId,
}: SaveTeamEntryParams): Promise<Response> {
  if (mode === "edit" && !initialId) {
    throw new Error("initialId is required for edit mode");
  }

  const entryId = mode === "create" ? crypto.randomUUID() : initialId!;

  const blobAAD = buildTeamEntryAAD(teamId, entryId, "blob");
  const overviewAAD = buildTeamEntryAAD(teamId, entryId, "overview");

  const encryptedBlob = await encryptData(fullBlob, teamEncryptionKey, blobAAD);
  const encryptedOverview = await encryptData(overviewBlob, teamEncryptionKey, overviewAAD);

  const body: Record<string, unknown> = {
    encryptedBlob,
    encryptedOverview,
    aadVersion: AAD_VERSION,
    orgKeyVersion: teamKeyVersion,
    tagIds,
  };

  // Send client-generated ID so the server uses the same ID that was bound into the AAD
  if (mode === "create") body.id = entryId;

  if (entryType !== undefined) body.entryType = entryType;
  if (teamFolderId !== undefined) body.orgFolderId = teamFolderId;

  const endpoint = mode === "create"
    ? apiPath.teamPasswords(teamId)
    : apiPath.teamPasswordById(teamId, initialId!);
  const method = mode === "create" ? "POST" : "PUT";

  return fetch(endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
