"use client";

import { useEffect, useState, useCallback, useImperativeHandle } from "react";
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
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  reconcileSelectedIds,
  toggleSelectAllIds,
  toggleSelectOneId,
} from "./password-list-selection";

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
  requireReprompt?: boolean;
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
  tags: EntryTagNameColor[];
  isFavorite: boolean;
  isArchived: boolean;
  requireReprompt: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SortOption = EntrySortOption;

export interface PasswordListHandle {
  toggleSelectAll: (checked: boolean) => void;
  allSelected: boolean;
}

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
  onSelectedCountChange?: (count: number, allSelected: boolean) => void;
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
  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<"trash" | "archive" | "unarchive">("trash");
  const [bulkProcessing, setBulkProcessing] = useState(false);

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

      const res = await fetch(`${API_PATH.PASSWORDS}?${params}`);
      if (!res.ok) return;
      const data = await res.json();

      // Decrypt overviews client-side
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

          // Client-side search filtering
          if (searchQuery) {
            const q = searchQuery.toLowerCase();
            const matches =
              overview.title.toLowerCase().includes(q) ||
              (overview.username?.toLowerCase().includes(q) ?? false) ||
              (overview.urlHost?.toLowerCase().includes(q) ?? false) ||
              (overview.snippet?.toLowerCase().includes(q) ?? false) ||
              (overview.brand?.toLowerCase().includes(q) ?? false) ||
              (overview.lastFour?.includes(q) ?? false) ||
              (overview.cardholderName?.toLowerCase().includes(q) ?? false) ||
              (overview.fullName?.toLowerCase().includes(q) ?? false) ||
              (overview.idNumberLast4?.includes(q) ?? false) ||
              (overview.relyingPartyId?.toLowerCase().includes(q) ?? false) ||
              (overview.bankName?.toLowerCase().includes(q) ?? false) ||
              (overview.accountNumberLast4?.includes(q) ?? false) ||
              (overview.softwareName?.toLowerCase().includes(q) ?? false) ||
              (overview.licensee?.toLowerCase().includes(q) ?? false);
            if (!matches) continue;
          }

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
            tags: overview.tags ?? [],
            isFavorite: entry.isFavorite ?? false,
            isArchived: entry.isArchived ?? false,
            requireReprompt: entry.requireReprompt ?? overview.requireReprompt ?? false,
            expiresAt: entry.expiresAt ?? null,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }

      // Client-side sorting
      decrypted.sort((a, b) => compareEntriesWithFavorite(a, b, sortBy));

      setEntries(decrypted);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  }, [searchQuery, tagId, folderId, entryType, encryptionKey, favoritesOnly, archivedOnly, sortBy, userId]);

  useEffect(() => {
    fetchPasswords();
  }, [fetchPasswords, refreshKey]);

  useEffect(() => {
    setSelectedIds((prev) => {
      return reconcileSelectedIds(prev, entries.map((e) => e.id));
    });
  }, [entries]);

  // Reset selection when leaving selection mode
  useEffect(() => {
    if (!selectionMode) setSelectedIds(new Set());
  }, [selectionMode]);

  // Sync selected count to parent
  useEffect(() => {
    onSelectedCountChange?.(selectedIds.size, entries.length > 0 && selectedIds.size === entries.length);
  }, [selectedIds.size, entries.length, onSelectedCountChange]);

  // Expose selectAll to parent via imperative handle
  useImperativeHandle(selectAllRef, () => ({
    toggleSelectAll: (checked: boolean) => {
      setSelectedIds(toggleSelectAllIds(entries.map((e) => e.id), checked));
    },
    allSelected: entries.length > 0 && selectedIds.size === entries.length,
  }), [entries, selectedIds]);

  const handleToggleFavorite = async (id: string, current: boolean) => {
    // Optimistic update
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, isFavorite: !current } : e))
    );

    try {
      const res = await fetch(apiPath.passwordById(id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: !current }),
      });
      if (!res.ok) {
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, isFavorite: current } : e))
        );
      }
    } catch {
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, isFavorite: current } : e))
      );
    }
  };

  const handleToggleArchive = async (id: string, current: boolean) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(apiPath.passwordById(id), {
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
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(apiPath.passwordById(id), { method: "DELETE" });
      if (!res.ok) fetchPasswords();
    } catch {
      fetchPasswords();
    }
    onDataChange?.();
  };

  const toggleSelectOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => toggleSelectOneId(prev, id, checked));
  };

  const handleBulkAction = async () => {
    if (selectedIds.size === 0) return;
    setBulkProcessing(true);
    try {
      const endpoint =
        bulkAction === "archive" || bulkAction === "unarchive"
          ? apiPath.passwordsBulkArchive()
          : apiPath.passwordsBulkTrash();
      const body =
        bulkAction === "archive" || bulkAction === "unarchive"
          ? { ids: Array.from(selectedIds), operation: bulkAction }
          : { ids: Array.from(selectedIds) };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("bulk action failed");
      const json = await res.json();
      if (bulkAction === "archive") {
        toast.success(
          t("bulkArchived", {
            count: json.processedCount ?? json.archivedCount ?? selectedIds.size,
          })
        );
      } else if (bulkAction === "unarchive") {
        toast.success(
          t("bulkUnarchived", {
            count:
              json.processedCount ?? json.unarchivedCount ?? selectedIds.size,
          })
        );
      } else {
        toast.success(
          t("bulkMovedToTrash", {
            count: json.movedCount ?? selectedIds.size,
          })
        );
      }
      setBulkDialogOpen(false);
      setSelectedIds(new Set());
      fetchPasswords();
      onDataChange?.();
    } catch {
      toast.error(
        bulkAction === "archive"
          ? t("bulkArchiveFailed")
          : bulkAction === "unarchive"
            ? t("bulkUnarchiveFailed")
            : t("bulkMoveFailed")
      );
    } finally {
      setBulkProcessing(false);
    }
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
            <p className="text-muted-foreground">{t("noArchive")}</p>
          </>
        ) : favoritesOnly ? (
          <>
            <Star className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">{t("noFavorites")}</p>
          </>
        ) : (
          <>
            <KeyRound className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">
              {searchQuery ? t("noMatch") : t("noPasswords")}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("addFirst")}
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        selectionMode ? (
          <div key={entry.id} className="flex items-start gap-2">
            <Checkbox
              className="mt-4"
              checked={selectedIds.has(entry.id)}
              onCheckedChange={(v) => toggleSelectOne(entry.id, Boolean(v))}
              aria-label={t("selectEntry", { title: entry.title })}
            />
            <div className="flex-1 min-w-0">
              <PasswordCard
                id={entry.id}
                entryType={entry.entryType}
                title={entry.title}
                username={entry.username}
                urlHost={entry.urlHost}
                snippet={entry.snippet}
                brand={entry.brand}
                lastFour={entry.lastFour}
                cardholderName={entry.cardholderName}
                fullName={entry.fullName}
                idNumberLast4={entry.idNumberLast4}
                relyingPartyId={entry.relyingPartyId}
                bankName={entry.bankName}
                accountNumberLast4={entry.accountNumberLast4}
                softwareName={entry.softwareName}
                licensee={entry.licensee}
                tags={entry.tags}
                isFavorite={entry.isFavorite}
                isArchived={entry.isArchived}
                requireReprompt={entry.requireReprompt}
                expiresAt={entry.expiresAt}
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
            id={entry.id}
            entryType={entry.entryType}
            title={entry.title}
            username={entry.username}
            urlHost={entry.urlHost}
            snippet={entry.snippet}
            brand={entry.brand}
            lastFour={entry.lastFour}
            cardholderName={entry.cardholderName}
            fullName={entry.fullName}
            idNumberLast4={entry.idNumberLast4}
            relyingPartyId={entry.relyingPartyId}
            bankName={entry.bankName}
            accountNumberLast4={entry.accountNumberLast4}
            softwareName={entry.softwareName}
            licensee={entry.licensee}
            tags={entry.tags}
            isFavorite={entry.isFavorite}
            isArchived={entry.isArchived}
            requireReprompt={entry.requireReprompt}
            expiresAt={entry.expiresAt}
            expanded={expandedId === entry.id}
            onToggleFavorite={handleToggleFavorite}
            onToggleArchive={handleToggleArchive}
            onDelete={handleDelete}
            onToggleExpand={handleToggleExpand}
            onRefresh={() => { fetchPasswords(); onDataChange?.(); }}
          />
        )
      ))}

      {selectionMode && selectedIds.size > 0 && (
        <div className="sticky bottom-4 z-40 mt-2 flex items-center justify-end rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex items-center gap-2">
            {archivedOnly ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setBulkAction("unarchive");
                  setBulkDialogOpen(true);
                }}
              >
                {t("moveSelectedToUnarchive")}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setBulkAction("archive");
                  setBulkDialogOpen(true);
                }}
              >
                {t("moveSelectedToArchive")}
              </Button>
            )}
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setBulkAction("trash");
                setBulkDialogOpen(true);
              }}
            >
              {t("moveSelectedToTrash")}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkAction === "archive"
                ? t("moveSelectedToArchive")
                : bulkAction === "unarchive"
                  ? t("moveSelectedToUnarchive")
                : t("moveSelectedToTrash")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkAction === "archive"
                ? t("bulkArchiveConfirm", { count: selectedIds.size })
                : bulkAction === "unarchive"
                  ? t("bulkUnarchiveConfirm", { count: selectedIds.size })
                : t("bulkMoveConfirm", { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkProcessing}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleBulkAction();
              }}
              disabled={bulkProcessing}
            >
              {bulkProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("confirm")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
