"use client";

import { decryptData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import type { InlineDetailData } from "@/types/entry";
import type { EntryTypeValue } from "@/lib/constants";
import type { EntryItemKeyData } from "@/lib/team/team-vault-core";
import { mapDecryptedBlobToDetailFields } from "@/lib/vault/map-detail-fields";

/**
 * Minimal entry fields needed to build the team getDetail closure.
 * These come from the overview row (DisplayEntry / TeamArchivedEntry) already in memory.
 */
interface TeamEntryOverview {
  id: string;
  entryType?: EntryTypeValue;
}

interface TeamGetDetailDeps {
  getEntryDecryptionKey: (teamId: string, entryId: string, entry: EntryItemKeyData) => Promise<CryptoKey>;
}

/**
 * Builds the team `getDetail` closure for use with `usePasswordEntryDetail`.
 *
 * Both `PasswordCard` (accordion body) and the team detail pane (master-detail)
 * consume this shared builder — there is ONE source of truth for team entry
 * field assembly (INV-C1.7, INV-C3.1, Commonization principle).
 *
 * The closure:
 *   1. Fetches the raw encrypted blob from the server.
 *   2. Derives the per-entry decryption key via getEntryDecryptionKey (ItemKey v>=1 or TeamKey v0).
 *   3. Decrypts it using AES-256-GCM with the team AAD (buildTeamEntryAAD, "blob" scope).
 *   4. Assembles the complete InlineDetailData from the decrypted fields.
 *
 * Team entries use urlHost: null and passwordHistory: [] in the detail pane — the team API
 * does not expose per-entry history or a parsed URL host in the inline detail view.
 */
export function buildTeamGetDetail(
  teamId: string,
  entry: TeamEntryOverview,
  deps: TeamGetDetailDeps,
): () => Promise<InlineDetailData> {
  const { getEntryDecryptionKey } = deps;

  return async (): Promise<InlineDetailData> => {
    const res = await fetchApi(apiPath.teamPasswordById(teamId, entry.id));
    if (!res.ok) {
      throw new Error("Failed to fetch entry");
    }
    const raw = await res.json() as Record<string, unknown>;

    const itemKeyVersion = (raw.itemKeyVersion as number) ?? 0;
    const decryptKey = await getEntryDecryptionKey(teamId, entry.id, {
      itemKeyVersion,
      encryptedItemKey: raw.encryptedItemKey as string | undefined,
      itemKeyIv: raw.itemKeyIv as string | undefined,
      itemKeyAuthTag: raw.itemKeyAuthTag as string | undefined,
      teamKeyVersion: (raw.teamKeyVersion as number) ?? 1,
    });

    const aad = buildTeamEntryAAD(teamId, entry.id, "blob", itemKeyVersion);
    const plaintext = await decryptData(
      {
        ciphertext: raw.encryptedBlob as string,
        iv: raw.blobIv as string,
        authTag: raw.blobAuthTag as string,
      },
      decryptKey,
      aad,
    );

    const blob = JSON.parse(plaintext) as Record<string, unknown>;

    return {
      ...mapDecryptedBlobToDetailFields(blob),
      id: raw.id as string,
      title: (blob.title as string) ?? undefined,
      entryType: entry.entryType,
      urlHost: null,
      passwordHistory: [],
      createdAt: raw.createdAt as string,
      updatedAt: raw.updatedAt as string,
    };
  };
}
