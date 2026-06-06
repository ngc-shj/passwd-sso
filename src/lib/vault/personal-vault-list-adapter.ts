"use client";

import { useMemo } from "react";
import { useVault } from "@/lib/vault/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { buildPersonalGetDetail } from "@/lib/vault/build-personal-get-detail";
import { fetchApi } from "@/lib/url-helpers";
import { API_PATH, apiPath, ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { filterTravelSafe } from "@/lib/auth/policy/travel-mode";
import { notifyVaultDataChanged } from "@/lib/events";
import { useTravelMode } from "@/hooks/use-travel-mode";
import type { VaultListAdapter, EntryListViewKind, EntryListQuery } from "@/lib/vault/vault-list-adapter";
import type { EntryTagNameColor } from "@/lib/vault/entry-form-types";
import type { BulkScope } from "@/hooks/bulk/use-bulk-action";
import type { DisplayEntry } from "@/types/display-entry";

/**
 * Raw overview fields decrypted from the encrypted OVERVIEW blob.
 * Internal to the personal adapter; not exported.
 */
interface PersonalDecryptedOverview {
  title: string;
  username?: string | null;
  urlHost?: string | null;
  snippet?: string | null;
  brand?: string | null;
  lastFour?: string | null;
  cardholderName?: string | null;
  fullName?: string | null;
  idNumberLast4?: string | null;
  relyingPartyId?: string | null;
  bankName?: string | null;
  accountNumberLast4?: string | null;
  softwareName?: string | null;
  licensee?: string | null;
  keyType?: string | null;
  fingerprint?: string | null;
  requireReprompt?: boolean;
  travelSafe?: boolean;
  tags: EntryTagNameColor[];
}

/**
 * C5 — decryptPersonalOverview
 *
 * The SINGLE site that derives the personal OVERVIEW-scope AAD and maps raw
 * server entry data → DisplayEntry (INV-C5.2 / S1 acceptance).
 *
 * Decrypt-failure policy: throws on failure so callers can SKIP the entry
 * (matching today's personal behavior — F6).
 */
export async function decryptPersonalOverview(
  rawEntry: Record<string, unknown>,
  opts: { encryptionKey: CryptoKey; userId: string | null },
): Promise<DisplayEntry> {
  const { encryptionKey, userId } = opts;

  // INV-C5.2: this is the ONLY personal OVERVIEW-scope AAD derivation site.
  const aad = (rawEntry.aadVersion as number) >= 1 && userId
    ? buildPersonalEntryAAD(userId, rawEntry.id as string, VAULT_TYPE.OVERVIEW)
    : undefined;

  const overview: PersonalDecryptedOverview = JSON.parse(
    await decryptData(
      rawEntry.encryptedOverview as EncryptedData,
      encryptionKey,
      aad,
    )
  );

  return {
    id: rawEntry.id as string,
    entryType: ((rawEntry.entryType as string | undefined) ?? ENTRY_TYPE.LOGIN) as EntryTypeValue,
    title: overview.title,
    username: overview.username ?? null,
    urlHost: overview.urlHost ?? null,
    snippet: overview.snippet ?? null,
    brand: overview.brand ?? null,
    lastFour: overview.lastFour ?? null,
    cardholderName: overview.cardholderName ?? null,
    fullName: overview.fullName ?? null,
    idNumberLast4: overview.idNumberLast4 ?? null,
    relyingPartyId: overview.relyingPartyId ?? null,
    bankName: overview.bankName ?? null,
    accountNumberLast4: overview.accountNumberLast4 ?? null,
    softwareName: overview.softwareName ?? null,
    licensee: overview.licensee ?? null,
    keyType: overview.keyType ?? null,
    fingerprint: overview.fingerprint ?? null,
    tags: overview.tags ?? [],
    isFavorite: (rawEntry.isFavorite as boolean) ?? false,
    isArchived: (rawEntry.isArchived as boolean) ?? false,
    requireReprompt: (rawEntry.requireReprompt as boolean) ?? overview.requireReprompt ?? false,
    travelSafe: overview.travelSafe !== false,
    expiresAt: (rawEntry.expiresAt as string | null) ?? null,
    createdAt: rawEntry.createdAt as string,
    updatedAt: rawEntry.updatedAt as string,
    // INV-C5.1: deletedAt is present only for trash entries (from the raw server row).
    ...(rawEntry.deletedAt != null ? { deletedAt: rawEntry.deletedAt as string } : {}),
  };
}

/**
 * C5 — usePersonalVaultListAdapter
 *
 * Returns a VaultListAdapter<DisplayEntry> for the personal vault. Reproduces
 * today's personal PasswordList + TrashList data layer exactly (F-R1).
 *
 * Availability: { ready: !!encryptionKey, reason: "locked" }
 * Permissions: all true (owner-only vault).
 * supportsFavorite: true.
 * Decrypt-failure policy: SKIP failed entries (continue), matching today — F6.
 */
export function usePersonalVaultListAdapter(): VaultListAdapter<DisplayEntry> {
  const { encryptionKey, userId } = useVault();
  const { active: travelModeActive } = useTravelMode();

  // Memoize so the adapter reference is stable across re-renders when the
  // underlying values haven't changed. This prevents useEntryListData's
  // useEffect from re-triggering on every render (infinite loop guard).
  const adapter: VaultListAdapter<DisplayEntry> = useMemo(() => ({
    kind: "personal",
    teamId: undefined,
    availability: {
      ready: !!encryptionKey,
      reason: "locked",
    },
    permissions: {
      canCreate: true,
      canEdit: true,
      canDelete: true,
      canShare: true,
    },
    supportsFavorite: true,

    async fetchOverviewEntries(
      view: EntryListViewKind,
      query: EntryListQuery,
      signal: AbortSignal,
    ): Promise<DisplayEntry[]> {
      if (!encryptionKey) return [];

      const params = new URLSearchParams();
      if (query.tagId) params.set("tag", query.tagId);
      if (query.folderId) params.set("folder", query.folderId);
      if (query.entryType) params.set("type", query.entryType);

      // Map view to API query params.
      if (view === "favorites") params.set("favorites", "true");
      if (view === "archive") params.set("archived", "true");
      if (view === "trash") params.set("trash", "true");

      const url = `${API_PATH.PASSWORDS}?${params}`;
      const res = await fetchApi(url, { signal });
      if (!res.ok) return [];

      const data = await res.json() as Record<string, unknown>[];

      // Decrypt overview blobs. Skip entries that fail to decrypt (F6).
      const decrypted: DisplayEntry[] = [];
      for (const rawEntry of data) {
        if (!rawEntry.encryptedOverview) continue;
        try {
          const entry = await decryptPersonalOverview(rawEntry, { encryptionKey, userId });
          decrypted.push(entry);
        } catch {
          // Skip entries that fail to decrypt (F6 — personal policy: skip).
        }
      }

      // Client-side travel mode filter.
      return filterTravelSafe(decrypted, travelModeActive);
    },

    buildGetDetail(entry: DisplayEntry) {
      if (!encryptionKey) {
        return async () => { throw new Error("Vault locked"); };
      }
      const getDetail = buildPersonalGetDetail(entry, { encryptionKey, userId });
      return () => getDetail(entry.id);
    },

    // INV-C1.4: network-only mutations; view owns optimistic removal + notify.

    async setFavorite(entry: DisplayEntry, next: boolean): Promise<void> {
      const res = await fetchApi(apiPath.passwordById(entry.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: next }),
      });
      if (!res.ok) throw new Error("setFavorite failed");
    },

    async setArchived(entry: DisplayEntry, next: boolean): Promise<void> {
      const res = await fetchApi(apiPath.passwordById(entry.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: next }),
      });
      if (!res.ok) throw new Error("setArchived failed");
    },

    async softDelete(entry: DisplayEntry): Promise<void> {
      const res = await fetchApi(apiPath.passwordById(entry.id), { method: "DELETE" });
      if (!res.ok) throw new Error("softDelete failed");
    },

    async restore(entry: DisplayEntry): Promise<void> {
      const res = await fetchApi(apiPath.passwordRestore(entry.id), { method: "POST" });
      if (!res.ok) throw new Error("restore failed");
    },

    async deletePermanently(entry: DisplayEntry): Promise<void> {
      const res = await fetchApi(`${apiPath.passwordById(entry.id)}?permanent=true`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("deletePermanently failed");
    },

    async emptyTrash(): Promise<void> {
      const res = await fetchApi(API_PATH.PASSWORDS_EMPTY_TRASH, { method: "POST" });
      if (!res.ok) throw new Error("emptyTrash failed");
    },

    bulkScope(_view: EntryListViewKind): BulkScope {
      return { type: "personal" };
    },

    notifyDataChanged() {
      notifyVaultDataChanged();
    },
  }), [encryptionKey, userId, travelModeActive]);

  return adapter;
}
