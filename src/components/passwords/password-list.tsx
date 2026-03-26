"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import { compareEntriesWithFavorite, type EntrySortOption } from "@/lib/entry-sort";
import { PasswordCard } from "./password-card";
import { Archive, KeyRound, Loader2, Star } from "lucide-react";
import type { EntryTypeValue } from "@/lib/constants";
import { API_PATH, ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTagNameColor } from "@/lib/entry-form-types";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useBulkSelection, type BulkSelectionHandle } from "@/hooks/use-bulk-selection";
import { useBulkAction } from "@/hooks/use-bulk-action";
import { BulkActionConfirmDialog } from "@/components/bulk/bulk-action-confirm-dialog";
import { FloatingActionBar } from "@/components/bulk/floating-action-bar";
import { fetchApi } from "@/lib/url-helpers";
import { filterTravelSafe } from "@/lib/travel-mode";
import { useTravelMode } from "@/hooks/use-travel-mode";

interface DecryptedOverview {
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

interface DisplayEntry {
  id: string;
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  cardholderName: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  relyingPartyId: string | null;
  bankName: string | null;
  accountNumberLast4: string | null;
  softwareName: string | null;
  licensee: string | null;
  keyType: string | null;
  fingerprint: string | null;
  tags: EntryTagNameColor[];
  isFavorite: boolean;
  isArchived: boolean;
  requireReprompt: boolean;
  travelSafe: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SortOption = EntrySortOption;

export type PasswordListHandle = BulkSelectionHandle;

interface PasswordListProps {
  searchQuery: string;
  tagId: string | null;
  folderId?: string | null;
  entryType?: string | null;
  refreshKey: number;
  favoritesOnly?: boolean;
  archivedOnly?: boolean;
  sortBy?: SortOption;
  onDataChange?: () => void;
  selectionMode?: boolean;
  onSelectedCountChange?: (count: number, allSelected: boolean, atLimit: boolean) => void;
  selectAllRef?: React.Ref<PasswordListHandle>;
}


export function PasswordList({
  searchQuery,
  tagId,
  folderId,
  entryType,
  refreshKey,
  favoritesOnly = false,
  archivedOnly = false,
  sortBy = "updatedAt",
  onDataChange,
  selectionMode = false,
  onSelectedCountChange,
  selectAllRef,
}: PasswordListProps) {
  const t = useTranslations("PasswordList");
  const { encryptionKey, userId } = useVault();
  const { active: travelModeActive } = useTravelMode();
  // All decrypted entries fetched from the server (no search filter applied)
  const [allEntries, setAllEntries] = useState<DisplayEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleToggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const fetchPasswords = useCallback(async () => {
    if (!encryptionKey) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tagId) params.set("tag", tagId);
      if (folderId) params.set("folder", folderId);
      if (entryType) params.set("type", entryType);
      if (favoritesOnly) params.set("favorites", "true");
      if (archivedOnly) params.set("archived", "true");

      const res = await fetchApi(`${API_PATH.PASSWORDS}?${params}`);
      if (!res.ok) return;
      const data = await res.json();

      // Decrypt overviews client-side (no search filtering here — done via useMemo)
      const decrypted: DisplayEntry[] = [];
      for (const entry of data) {
        if (!entry.encryptedOverview) continue;
        try {
          const aad = entry.aadVersion >= 1 && userId
            ? buildPersonalEntryAAD(userId, entry.id)
            : undefined;
          const overview: DecryptedOverview = JSON.parse(
            await decryptData(
              entry.encryptedOverview as EncryptedData,
              encryptionKey,
              aad
            )
          );

          decrypted.push({
            id: entry.id,
            entryType: entry.entryType ?? ENTRY_TYPE.LOGIN,
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
            isFavorite: entry.isFavorite ?? false,
            isArchived: entry.isArchived ?? false,
            requireReprompt: entry.requireReprompt ?? overview.requireReprompt ?? false,
            travelSafe: overview.travelSafe !== false,
            expiresAt: entry.expiresAt ?? null,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }

      // Client-side travel mode filter
      const filtered = filterTravelSafe(decrypted, travelModeActive);

      // Client-side sorting
      filtered.sort((a, b) => compareEntriesWithFavorite(a, b, sortBy));

      setAllEntries(filtered);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  // searchQuery intentionally omitted — search is applied via useMemo below
  }, [tagId, folderId, entryType, encryptionKey, favoritesOnly, archivedOnly, sortBy, userId, travelModeActive]);

  // Apply client-side search filtering without re-fetching or re-decrypting
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

  useEffect(() => {
    fetchPasswords();
  }, [fetchPasswords, refreshKey]);

  // Bulk selection (replaces selectedIds state, reconcile/reset/count effects, useImperativeHandle)
  const entryIds = allEntries.map((e) => e.id);
  const { selectedIds, atLimit, toggleSelectOne, clearSelection } = useBulkSelection({
    entryIds,
    selectionMode,
    selectAllRef,
    onSelectedCountChange,
  });

  // Bulk action (replaces bulkDialogOpen/bulkAction/bulkProcessing states, handleBulkAction)
  const {
    dialogOpen: bulkDialogOpen,
    setDialogOpen: setBulkDialogOpen,
    pendingAction,
    processing: bulkProcessing,
    requestAction,
    executeAction,
  } = useBulkAction({
    selectedIds,
    scope: { type: "personal" },
    t,
    onSuccess: () => {
      clearSelection();
      fetchPasswords();
      onDataChange?.();
    },
  });

  const handleToggleFavorite = async (id: string, current: boolean) => {
    // Optimistic update: on the favorites-only view, unfavoriting removes the entry
    // immediately so the list reflects the new state without waiting for a re-fetch.
    if (favoritesOnly && current) {
      setAllEntries((prev) => prev.filter((e) => e.id !== id));
    } else {
      setAllEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, isFavorite: !current } : e))
      );
    }

    try {
      const res = await fetchApi(apiPath.passwordById(id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: !current }),
      });
      if (!res.ok) {
        fetchPasswords();
      }
    } catch {
      fetchPasswords();
    }
    onDataChange?.();
  };

  const handleToggleArchive = async (id: string, current: boolean) => {
    setAllEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetchApi(apiPath.passwordById(id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: !current }),
      });
      if (!res.ok) fetchPasswords();
    } catch {
      fetchPasswords();
    }
    onDataChange?.();
  };

  const handleDelete = async (id: string) => {
    setAllEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetchApi(apiPath.passwordById(id), { method: "DELETE" });
      if (!res.ok) fetchPasswords();
    } catch {
      fetchPasswords();
    }
    onDataChange?.();
  };


  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        {archivedOnly ? (
          <>
            <Archive className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">
              {searchQuery ? t("noMatch") : t("noArchive")}
            </p>
          </>
        ) : favoritesOnly ? (
          <>
            <Star className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">
              {searchQuery ? t("noMatch") : t("noFavorites")}
            </p>
          </>
        ) : (
          <>
            <KeyRound className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">
              {searchQuery ? t("noMatch") : t("noPasswords")}
            </p>
            {!searchQuery && (
              <p className="text-sm text-muted-foreground mt-1">
                {t("addFirst")}
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={selectionMode ? "space-y-2" : "space-y-1"}>
      {entries.map((entry) => (
        selectionMode ? (
          <div key={entry.id} className="flex items-start gap-2">
            <Checkbox
              className="mt-4"
              checked={selectedIds.has(entry.id)}
              disabled={atLimit && !selectedIds.has(entry.id)}
              onCheckedChange={(v) => toggleSelectOne(entry.id, Boolean(v))}
              aria-label={t("selectEntry", { title: entry.title })}
            />
            <div className="flex-1 min-w-0">
              <PasswordCard
                entry={entry}
                expanded={expandedId === entry.id}
                onToggleFavorite={handleToggleFavorite}
                onToggleArchive={handleToggleArchive}
                onDelete={handleDelete}
                onToggleExpand={handleToggleExpand}
                onRefresh={() => { fetchPasswords(); onDataChange?.(); }}
              />
            </div>
          </div>
        ) : (
          <PasswordCard
            key={entry.id}
            entry={entry}
            expanded={expandedId === entry.id}
            onToggleFavorite={handleToggleFavorite}
            onToggleArchive={handleToggleArchive}
            onDelete={handleDelete}
            onToggleExpand={handleToggleExpand}
            onRefresh={() => { fetchPasswords(); onDataChange?.(); }}
          />
        )
      ))}

      <FloatingActionBar visible={selectionMode && selectedIds.size > 0}>
        {archivedOnly ? (
          <Button variant="secondary" size="sm" onClick={() => requestAction("unarchive")}>
            {t("moveSelectedToUnarchive")}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => requestAction("archive")}>
            {t("moveSelectedToArchive")}
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={() => requestAction("trash")}>
          {t("moveSelectedToTrash")}
        </Button>
      </FloatingActionBar>

      <BulkActionConfirmDialog
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        title={
          pendingAction === "archive"
            ? t("moveSelectedToArchive")
            : pendingAction === "unarchive"
              ? t("moveSelectedToUnarchive")
              : t("moveSelectedToTrash")
        }
        description={
          pendingAction === "archive"
            ? t("bulkArchiveConfirm", { count: selectedIds.size })
            : pendingAction === "unarchive"
              ? t("bulkUnarchiveConfirm", { count: selectedIds.size })
              : t("bulkMoveConfirm", { count: selectedIds.size })
        }
        cancelLabel={t("cancel")}
        confirmLabel={t("confirm")}
        processing={bulkProcessing}
        onConfirm={() => void executeAction()}
      />
    </div>
  );
}
