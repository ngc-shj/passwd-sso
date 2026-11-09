import { buildPersonalEntryAAD, AAD_VERSION } from "@/lib/crypto/crypto-aad";
import { encryptData } from "@/lib/crypto/crypto-client";
import { API_PATH, apiPath } from "@/lib/constants";
import { buildEncryptedEntryBody, submitEntry } from "@/lib/vault/entry-save-core";
import type { EntryTypeValue } from "@/lib/constants";

interface SavePersonalEntryParams {
  mode: "create" | "edit";
  initialId?: string;
  encryptionKey: CryptoKey;
  userId: string;
  keyVersion: number;
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
  keyVersion,
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
  const body = await buildEncryptedEntryBody({
    mode,
    entryId,
    seal: (plaintext, vaultType) =>
      encryptData(plaintext, encryptionKey, buildPersonalEntryAAD(userId, entryId, vaultType)),
    fullBlob,
    overviewBlob,
    tagIds,
    extra: {
      keyVersion,
      aadVersion: AAD_VERSION,
    },
    optionals: { entryType, requireReprompt, expiresAt, folderId },
  });

  const endpoint = mode === "create" ? API_PATH.PASSWORDS : apiPath.passwordById(initialId!);
  const method = mode === "create" ? "POST" : "PUT";

  return submitEntry(endpoint, method, body);
}
