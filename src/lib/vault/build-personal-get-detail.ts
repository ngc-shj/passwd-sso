"use client";

import { decryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import type { InlineDetailData } from "@/types/entry";
import { mapDecryptedBlobToDetailFields } from "@/lib/vault/map-detail-fields";

/**
 * Minimal entry fields needed to build the personal getDetail closure.
 * These come from the overview row (DisplayEntry) which is already in memory.
 */
interface PersonalEntryOverview {
  id: string;
  entryType?: string;
  urlHost: string | null;
  requireReprompt?: boolean;
}

interface PersonalGetDetailOpts {
  encryptionKey: CryptoKey;
  userId: string | null;
}

/**
 * Builds the personal `getDetail` closure for use with `usePasswordEntryDetail`.
 *
 * Both `PasswordCard` (accordion body) and the personal detail pane (master-detail)
 * consume this shared builder — there is ONE source of truth for personal entry
 * field assembly (INV-C1.7, INV-C3.1, Commonization principle).
 *
 * The closure:
 *   1. Fetches the raw encrypted blob from the server.
 *   2. Decrypts it using AES-256-GCM with the personal AAD (aadVersion >= 1).
 *   3. Assembles the complete InlineDetailData from the decrypted fields + overview fallbacks.
 *
 * The caller must ensure encryptionKey is non-null before building this closure.
 * The hook (usePasswordEntryDetail) will not call getDetail when entryId is null or vault is locked.
 */
export function buildPersonalGetDetail(
  entry: PersonalEntryOverview,
  opts: PersonalGetDetailOpts,
): (id: string) => Promise<InlineDetailData> {
  const { encryptionKey, userId } = opts;

  return async (id: string): Promise<InlineDetailData> => {
    const res = await fetchApi(apiPath.passwordById(id));
    if (!res.ok) {
      throw new Error("Failed to fetch entry");
    }
    const raw = await res.json() as Record<string, unknown>;

    const aad = (raw.aadVersion as number) >= 1 && userId
      ? buildPersonalEntryAAD(userId, id, VAULT_TYPE.BLOB)
      : undefined;

    const plaintext = await decryptData(
      raw.encryptedBlob as EncryptedData,
      encryptionKey,
      aad,
    );

    const e = JSON.parse(plaintext) as Record<string, unknown>;

    return {
      ...mapDecryptedBlobToDetailFields(e),
      id,
      entryType: entry.entryType as InlineDetailData["entryType"],
      requireReprompt: (raw.requireReprompt as boolean | undefined) ?? entry.requireReprompt ?? false,
      urlHost: entry.urlHost,
      passwordHistory: (e.passwordHistory ?? []) as InlineDetailData["passwordHistory"],
      createdAt: raw.createdAt as string,
      updatedAt: raw.updatedAt as string,
    };
  };
}
