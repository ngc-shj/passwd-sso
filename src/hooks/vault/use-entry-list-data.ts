"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { VaultListAdapter, EntryListViewKind, EntryListQuery } from "@/lib/vault/vault-list-adapter";
import type { PasswordRowEntry } from "@/components/passwords/detail/password-row";
import type { PasswordDetailPaneEntry } from "@/components/passwords/detail/password-detail-pane";
import type { EntrySortOption } from "@/lib/vault/entry-sort";
import { compareEntriesWithFavorite, compareEntriesByDeletedAt } from "@/lib/vault/entry-sort";

/**
 * C4 — useEntryListData hook.
 *
 * Extracted from PasswordList's fetch/decrypt/sort/search block.
 * Calls adapter.fetchOverviewEntries, aborts the in-flight request on arg change
 * (INV-C4.1), applies client-side search filter + sort post-decrypt (INV-C4.2),
 * and skips fetching when the adapter is not ready (INV-C4.3).
 */
export function useEntryListData<E extends PasswordRowEntry & PasswordDetailPaneEntry>(args: {
  adapter: VaultListAdapter<E>;
  view: EntryListViewKind;
  query: EntryListQuery;
  searchQuery: string;
  sortBy: EntrySortOption;
  refreshKey: number;
  sort: "favoriteThenUpdated" | "deletedAt";
}): { entries: E[]; loading: boolean; error: Error | null; reload: () => void } {
  const { adapter, view, query, searchQuery, sortBy, refreshKey, sort } = args;

  // All decrypted entries before search filtering — needed so selection
  // state persists across search queries (useBulkSelection uses allEntries).
  const [allEntries, setAllEntries] = useState<E[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // reload() increments this counter to re-trigger the effect without changing
  // other args (used for rollback after a failed optimistic mutation).
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    // INV-C4.3: skip fetch when the adapter's vault is not ready.
    if (!adapter.availability.ready) {
      setAllEntries([]);
      setLoading(false);
      setError(null);
      return;
    }

    // INV-C4.1: abort the in-flight request when args change.
    const controller = new AbortController();
    const { signal } = controller;

    setLoading(true);
    setError(null);

    adapter.fetchOverviewEntries(view, query, signal)
      .then((fetched) => {
        if (signal.aborted) return; // INV-C4.1: no stale overwrite
        // INV-C4.2: sort AFTER decrypt.
        const sorted = [...fetched];
        if (sort === "deletedAt") {
          // deletedAt sort: entries must carry deletedAt (trash view only).
          sorted.sort((a, b) =>
            compareEntriesByDeletedAt(
              a as unknown as { title: string; deletedAt: string },
              b as unknown as { title: string; deletedAt: string },
              sortBy,
            )
          );
        } else {
          sorted.sort((a, b) =>
            compareEntriesWithFavorite(
              a as unknown as { title: string; isFavorite: boolean; createdAt: string; updatedAt: string },
              b as unknown as { title: string; isFavorite: boolean; createdAt: string; updatedAt: string },
              sortBy,
            )
          );
        }
        setAllEntries(sorted);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  // searchQuery intentionally excluded — filtering is via useMemo below (INV-C4.2).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, view, query.tagId, query.folderId, query.entryType, sort, sortBy, refreshKey, reloadKey]);

  // INV-C4.2: apply client-side search filter without re-fetching or re-decrypting.
  const entries = useMemo(() => {
    if (!searchQuery) return allEntries;
    const q = searchQuery.toLowerCase();
    return allEntries.filter((entry) =>
      entry.title.toLowerCase().includes(q) ||
      (entry.username?.toLowerCase().includes(q) ?? false) ||
      (entry.urlHost?.toLowerCase().includes(q) ?? false) ||
      (entry.snippet?.toLowerCase().includes(q) ?? false) ||
      (entry.brand?.toLowerCase().includes(q) ?? false) ||
      (entry.lastFour?.includes(q) ?? false) ||
      (entry.cardholderName?.toLowerCase().includes(q) ?? false) ||
      (entry.fullName?.toLowerCase().includes(q) ?? false) ||
      (entry.idNumberLast4?.includes(q) ?? false) ||
      (entry.relyingPartyId?.toLowerCase().includes(q) ?? false) ||
      (entry.bankName?.toLowerCase().includes(q) ?? false) ||
      (entry.accountNumberLast4?.includes(q) ?? false) ||
      (entry.softwareName?.toLowerCase().includes(q) ?? false) ||
      (entry.licensee?.toLowerCase().includes(q) ?? false) ||
      (entry.keyType?.toLowerCase().includes(q) ?? false) ||
      (entry.fingerprint?.toLowerCase().includes(q) ?? false)
    );
  }, [allEntries, searchQuery]);

  return { entries, loading, error, reload };
}
