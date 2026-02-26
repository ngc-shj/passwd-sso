import { encryptData } from "@/lib/crypto-client";
import { buildOrgEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

interface SaveOrgEntryParams {
  mode: "create" | "edit";
  teamId: string;
  initialId?: string;
  orgEncryptionKey: CryptoKey;
  orgKeyVersion: number;
  fullBlob: string;
  overviewBlob: string;
  entryType?: EntryTypeValue;
  tagIds: string[];
  orgFolderId?: string | null;
}

export async function saveOrgEntry({
  mode,
  teamId,
  initialId,
  orgEncryptionKey,
  orgKeyVersion,
  fullBlob,
  overviewBlob,
  entryType,
  tagIds,
  orgFolderId,
}: SaveOrgEntryParams): Promise<Response> {
  if (mode === "edit" && !initialId) {
    throw new Error("initialId is required for edit mode");
  }

  const entryId = mode === "create" ? crypto.randomUUID() : initialId!;

  const blobAAD = buildOrgEntryAAD(teamId, entryId, "blob");
  const overviewAAD = buildOrgEntryAAD(teamId, entryId, "overview");

  const encryptedBlob = await encryptData(fullBlob, orgEncryptionKey, blobAAD);
  const encryptedOverview = await encryptData(overviewBlob, orgEncryptionKey, overviewAAD);

  const body: Record<string, unknown> = {
    encryptedBlob,
    encryptedOverview,
    aadVersion: AAD_VERSION,
    orgKeyVersion,
    tagIds,
  };

  // Send client-generated ID so the server uses the same ID that was bound into the AAD
  if (mode === "create") body.id = entryId;

  if (entryType !== undefined) body.entryType = entryType;
  if (orgFolderId !== undefined) body.orgFolderId = orgFolderId;

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
