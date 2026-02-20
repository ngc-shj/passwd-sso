import { encryptData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import { API_PATH, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

interface SavePersonalEntryParams {
  mode: "create" | "edit";
  initialId?: string;
  encryptionKey: CryptoKey;
  userId?: string;
  fullBlob: string;
  overviewBlob: string;
  tagIds: string[];
  entryType?: EntryTypeValue;
  requireReprompt?: boolean;
  expiresAt?: string | null;
  folderId?: string | null;
}

export async function savePersonalEntry({
  mode,
  initialId,
  encryptionKey,
  userId,
  fullBlob,
  overviewBlob,
  tagIds,
  entryType,
  requireReprompt,
  expiresAt,
  folderId,
}: SavePersonalEntryParams): Promise<Response> {
  if (mode === "edit" && !initialId) {
    throw new Error("initialId is required for edit mode");
  }

  const entryId = mode === "create" ? crypto.randomUUID() : initialId!;
  const aad = userId ? buildPersonalEntryAAD(userId, entryId) : undefined;

  const encryptedBlob = await encryptData(fullBlob, encryptionKey, aad);
  const encryptedOverview = await encryptData(overviewBlob, encryptionKey, aad);

  const body: Record<string, unknown> = {
    ...(mode === "create" ? { id: entryId } : {}),
    encryptedBlob,
    encryptedOverview,
    keyVersion: 1,
    aadVersion: aad ? AAD_VERSION : 0,
    tagIds,
  };

  if (entryType !== undefined) body.entryType = entryType;
  if (requireReprompt !== undefined) body.requireReprompt = requireReprompt;
  if (expiresAt !== undefined) body.expiresAt = expiresAt;
  if (folderId !== undefined) body.folderId = folderId;

  const endpoint = mode === "create" ? API_PATH.PASSWORDS : apiPath.passwordById(initialId!);
  const method = mode === "create" ? "POST" : "PUT";

  return fetch(endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
