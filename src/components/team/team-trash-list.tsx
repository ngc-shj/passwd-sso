"use client";

import { useEffect, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Building2, Trash2, RotateCcw, Loader2, FileText, CreditCard, IdCard } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, ENTRY_TYPE, API_PATH, apiPath } from "@/lib/constants";
import {
  reconcileSelectedIds,
  toggleSelectAllIds,
  toggleSelectOneId,
} from "@/components/passwords/password-list-selection";
import type { EntryTypeValue } from "@/lib/constants";
import {
  compareEntriesByDeletedAt,
  type EntrySortOption,
} from "@/lib/entry-sort";
import { useTeamVault } from "@/lib/team-vault-context";
import { decryptData } from "@/lib/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto-aad";

interface TeamTrashEntry {
  id: string;
  entryType: EntryTypeValue;
  teamId: string;
  teamName: string;
  role: string;
  title: string;
  username: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  deletedAt: string;
}

export interface TeamTrashListHandle {
  toggleSelectAll: (checked: boolean) => void;
  allSelected: boolean;
}

interface TeamTrashListProps {
  teamId?: string;
  searchQuery?: string;
  refreshKey: number;
  sortBy?: EntrySortOption;
  selectionMode?: boolean;
  onSelectedCountChange?: (count: number, allSelected: boolean) => void;
  selectAllRef?: React.Ref<TeamTrashListHandle>;
}

export const TeamTrashList = forwardRef<TeamTrashListHandle, TeamTrashListProps>(
  function TeamTrashList(
    {
      teamId: scopedTeamId,
      searchQuery = "",
      refreshKey,
      sortBy = "updatedAt",
      selectionMode: selectionModeProp,
      onSelectedCountChange,
      selectAllRef,
    },
    ref,
  ) {
  const t = useTranslations("Trash");
  const tTeam = useTranslations("Team");
  const tl = useTranslations("PasswordList");
  const { getTeamEncryptionKey } = useTeamVault();
  const [entries, setEntries] = useState<TeamTrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkProcessing, setBulkProcessing] = useState(false);

  // Selection only works when scoped to a single team
  const effectiveSelectionMode = scopedTeamId ? (selectionModeProp ?? false) : false;

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(API_PATH.TEAMS_TRASH);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;

      const decrypted = await Promise.all(
        data.map(async (entry: Record<string, unknown>) => {
          try {
            const entryTeamId = entry.teamId as string;
            const teamKey = await getTeamEncryptionKey(entryTeamId);
            if (!teamKey) throw new Error("No team key");
            const aad = buildTeamEntryAAD(entryTeamId, entry.id as string, "overview");
            const json = await decryptData(
              {
                ciphertext: entry.encryptedOverview as string,
                iv: entry.overviewIv as string,
                authTag: entry.overviewAuthTag as string,
              },
              teamKey,
              aad,
            );
            const overview = JSON.parse(json);
            return {
              id: entry.id,
              entryType: entry.entryType,
              teamId: entryTeamId,
              teamName: entry.teamName,
              role: entry.role,
              title: overview.title ?? "",
              username: overview.username ?? null,
              snippet: overview.snippet ?? null,
              brand: overview.brand ?? null,
              lastFour: overview.lastFour ?? null,
              fullName: overview.fullName ?? null,
              idNumberLast4: overview.idNumberLast4 ?? null,
              deletedAt: entry.deletedAt,
            } as TeamTrashEntry;
          } catch {
            return {
              id: entry.id as string,
              entryType: entry.entryType as EntryTypeValue,
              teamId: entry.teamId as string,
              teamName: entry.teamName as string,
              role: entry.role as string,
              title: "(decryption failed)",
              username: null,
              snippet: null,
              brand: null,
              lastFour: null,
              fullName: null,
              idNumberLast4: null,
              deletedAt: entry.deletedAt as string,
            } as TeamTrashEntry;
          }
        }),
      );
      setEntries(decrypted);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  }, [getTeamEncryptionKey]);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash, refreshKey]);

  const filtered = entries.filter((entry) => {
    if (scopedTeamId && entry.teamId !== scopedTeamId) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      entry.title.toLowerCase().includes(q) ||
      entry.username?.toLowerCase().includes(q) ||
      entry.snippet?.toLowerCase().includes(q) ||
      entry.brand?.toLowerCase().includes(q) ||
      entry.lastFour?.includes(q) ||
      entry.fullName?.toLowerCase().includes(q) ||
      entry.idNumberLast4?.includes(q) ||
      entry.teamName.toLowerCase().includes(q)
    );
  });

  const sortedFiltered = [...filtered].sort((a, b) =>
    compareEntriesByDeletedAt(a, b, sortBy)
  );

  const sortedFilteredIds = sortedFiltered.map((e) => e.id);

  // Reconcile stale selectedIds when entries change
  useEffect(() => {
    setSelectedIds((prev) => {
      return reconcileSelectedIds(prev, sortedFilteredIds);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Reset selection when leaving selection mode
  useEffect(() => {
    if (!effectiveSelectionMode) setSelectedIds(new Set());
  }, [effectiveSelectionMode]);

  // Sync selected count to parent
  useEffect(() => {
    onSelectedCountChange?.(selectedIds.size, sortedFilteredIds.length > 0 && selectedIds.size === sortedFilteredIds.length);
  }, [selectedIds.size, sortedFilteredIds.length, onSelectedCountChange]);

  // Expose selectAll to parent via imperative handle
  useImperativeHandle(selectAllRef ?? ref, () => ({
    toggleSelectAll: (checked: boolean) => {
      setSelectedIds(toggleSelectAllIds(sortedFilteredIds, checked));
    },
    allSelected: sortedFilteredIds.length > 0 && selectedIds.size === sortedFilteredIds.length,
  }), [sortedFilteredIds, selectedIds]);

  const toggleSelectOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => toggleSelectOneId(prev, id, checked));
  };

  const handleBulkRestore = async () => {
    if (selectedIds.size === 0 || !scopedTeamId) return;
    setBulkProcessing(true);
    try {
      const res = await fetch(apiPath.teamPasswordsBulkRestore(scopedTeamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        toast.error(t("bulkRestoreFailed"));
        return;
      }
      const json = await res.json();
      toast.success(
        t("bulkRestored", { count: json.restoredCount ?? selectedIds.size })
      );
      setBulkDialogOpen(false);
      setSelectedIds(new Set());
      fetchTrash();
    } catch {
      toast.error(t("bulkRestoreFailed"));
    } finally {
      setBulkProcessing(false);
    }
  };

  const handleRestore = async (entry: TeamTrashEntry) => {
    try {
      const res = await fetch(
        apiPath.teamPasswordRestore(entry.teamId, entry.id),
        { method: "POST" }
      );
      if (res.ok) {
        toast.success(t("restored"));
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      } else {
        toast.error(t("failedAction"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleDeletePermanently = async (entry: TeamTrashEntry) => {
    try {
      const res = await fetch(
        `${apiPath.teamPasswordById(entry.teamId, entry.id)}?permanent=true`,
        { method: "DELETE" }
      );
      if (res.ok) {
        toast.success(t("deletedPermanently"));
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      } else {
        toast.error(t("failedAction"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  if (loading || sortedFiltered.length === 0) return null;

  return (
    <div className="mt-6">
      {!scopedTeamId && (
        <div className="mb-3 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-muted-foreground">
            {tTeam("trash")}
          </h2>
        </div>
      )}
      <div className="space-y-2">
        {sortedFiltered.map((entry) => (
          <Card key={entry.id} className="transition-colors hover:bg-accent">
            <CardContent className="flex items-center gap-3 px-4 py-2">
              {effectiveSelectionMode && (
                <Checkbox
                  checked={selectedIds.has(entry.id)}
                  onCheckedChange={(v) => toggleSelectOne(entry.id, Boolean(v))}
                  aria-label={tl("selectEntry", { title: entry.title })}
                />
              )}
              {entry.entryType === ENTRY_TYPE.IDENTITY ? (
                <IdCard className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : entry.entryType === ENTRY_TYPE.CREDIT_CARD ? (
                <CreditCard className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : entry.entryType === ENTRY_TYPE.SECURE_NOTE ? (
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : null}
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{entry.title}</p>
                <div className="flex items-center gap-2">
                  {entry.entryType === ENTRY_TYPE.IDENTITY ? (
                    (entry.fullName || entry.idNumberLast4) && (
                      <p className="text-sm text-muted-foreground truncate">
                        {entry.fullName}{entry.fullName && entry.idNumberLast4 ? " " : ""}{entry.idNumberLast4 ? `•••• ${entry.idNumberLast4}` : ""}
                      </p>
                    )
                  ) : entry.entryType === ENTRY_TYPE.CREDIT_CARD ? (
                    (entry.brand || entry.lastFour) && (
                      <p className="text-sm text-muted-foreground truncate">
                        {entry.brand}{entry.brand && entry.lastFour ? " " : ""}{entry.lastFour ? `•••• ${entry.lastFour}` : ""}
                      </p>
                    )
                  ) : entry.entryType === ENTRY_TYPE.SECURE_NOTE ? (
                    entry.snippet && (
                      <p className="text-sm text-muted-foreground truncate">
                        {entry.snippet}
                      </p>
                    )
                  ) : (
                    entry.username && (
                      <p className="text-sm text-muted-foreground truncate">
                        {entry.username}
                      </p>
                    )
                  )}
                  <span className="text-xs text-muted-foreground">
                    {entry.teamName}
                  </span>
                </div>
              </div>
              {(entry.role === TEAM_ROLE.OWNER || entry.role === TEAM_ROLE.ADMIN) && (
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRestore(entry)}
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    {t("restore")}
                  </Button>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="destructive" size="sm">
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        {t("deletePermanently")}
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t("deletePermanently")}</DialogTitle>
                        <DialogDescription>
                          {t("deleteConfirm", { title: entry.title })}
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <Button
                          variant="destructive"
                          onClick={() => handleDeletePermanently(entry)}
                        >
                          {t("deletePermanently")}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {effectiveSelectionMode && selectedIds.size > 0 && (
        <div className="fixed bottom-4 inset-x-0 z-40 flex justify-center px-4 md:pl-60 pointer-events-none">
          <div className="pointer-events-auto w-full max-w-4xl flex items-center justify-end rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <Button
              size="sm"
              onClick={() => setBulkDialogOpen(true)}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              {t("restoreSelected")}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("restoreSelected")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("bulkRestoreConfirm", { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkProcessing}>
              {tl("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleBulkRestore();
              }}
              disabled={bulkProcessing}
            >
              {bulkProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                tl("confirm")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
