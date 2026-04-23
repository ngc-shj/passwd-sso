"use client";

import { useEffect, useState, useCallback, forwardRef } from "react";
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
import { Trash2, Loader2, RotateCcw, FileText, CreditCard, IdCard } from "lucide-react";
import { toast } from "sonner";
import { useBulkSelection } from "@/hooks/bulk/use-bulk-selection";
import { useBulkAction } from "@/hooks/bulk/use-bulk-action";
import { EntryListShell, type EntrySelectionState } from "@/components/bulk/entry-list-shell";
import { TEAM_ROLE, ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { BulkSelectionHandle } from "@/hooks/bulk/use-bulk-selection";
import {
  compareEntriesByDeletedAt,
  type EntrySortOption,
} from "@/lib/vault/entry-sort";
import { useTeamVault } from "@/lib/team/team-vault-context";
import { decryptData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";

interface TeamTrashEntry {
  id: string;
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  deletedAt: string;
}

export type TeamTrashListHandle = BulkSelectionHandle;

interface TeamTrashListProps {
  teamId: string;
  teamName: string;
  role: string;
  searchQuery?: string;
  refreshKey: number;
  sortBy?: EntrySortOption;
  selectionMode?: boolean;
  onSelectedCountChange?: (count: number, allSelected: boolean, atLimit: boolean) => void;
}

export const TeamTrashList = forwardRef<TeamTrashListHandle, TeamTrashListProps>(
  function TeamTrashList(
    {
      teamId,
      teamName,
      role,
      searchQuery = "",
      refreshKey,
      sortBy = "updatedAt",
      selectionMode: selectionModeProp,
      onSelectedCountChange,
    },
    ref,
  ) {
  const t = useTranslations("Trash");
  const tl = useTranslations("PasswordList");
  const { getEntryDecryptionKey } = useTeamVault();
  const [entries, setEntries] = useState<TeamTrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [isEmptying, setIsEmptying] = useState(false);

  const effectiveSelectionMode = selectionModeProp ?? false;

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchApi(`${apiPath.teamPasswords(teamId)}?trash=true`);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;

      const decrypted = await Promise.all(
        data.map(async (entry: Record<string, unknown>) => {
          try {
            const entryId = entry.id as string;
            const itemKeyVersion = (entry.itemKeyVersion as number) ?? 0;
            const decryptKey = await getEntryDecryptionKey(teamId, entryId, {
              itemKeyVersion,
              encryptedItemKey: entry.encryptedItemKey as string | undefined,
              itemKeyIv: entry.itemKeyIv as string | undefined,
              itemKeyAuthTag: entry.itemKeyAuthTag as string | undefined,
              teamKeyVersion: (entry.teamKeyVersion as number) ?? 1,
            });
            const aad = buildTeamEntryAAD(teamId, entryId, "overview", itemKeyVersion);
            const json = await decryptData(
              {
                ciphertext: entry.encryptedOverview as string,
                iv: entry.overviewIv as string,
                authTag: entry.overviewAuthTag as string,
              },
              decryptKey,
              aad,
            );
            const overview = JSON.parse(json);
            return {
              id: entry.id,
              entryType: entry.entryType,
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
  }, [teamId, getEntryDecryptionKey]);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash, refreshKey]);

  const filtered = entries.filter((entry) => {
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
      teamName.toLowerCase().includes(q)
    );
  });

  const sortedFiltered = [...filtered].sort((a, b) =>
    compareEntriesByDeletedAt(a, b, sortBy)
  );

  const sortedFilteredIds = sortedFiltered.map((e) => e.id);

  const { selectedIds, atLimit, toggleSelectOne, clearSelection } = useBulkSelection({
    entryIds: sortedFilteredIds,
    selectionMode: effectiveSelectionMode,
    selectAllRef: ref,
    onSelectedCountChange,
  });

  const {
    dialogOpen: bulkDialogOpen,
    setDialogOpen: setBulkDialogOpen,
    pendingAction,
    processing: bulkProcessing,
    requestAction,
    executeAction,
  } = useBulkAction({
    selectedIds,
    scope: { type: "team", teamId },
    t,
    onSuccess: () => {
      clearSelection();
      fetchTrash();
    },
  });

  const handleRestore = async (entry: TeamTrashEntry) => {
    try {
      const res = await fetchApi(
        apiPath.teamPasswordRestore(teamId, entry.id),
        { method: "POST" }
      );
      if (res.ok) {
        toast.success(t("restored"));
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
        notifyTeamDataChanged();
      } else {
        toast.error(t("failedAction"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleEmptyTrash = async () => {
    setIsEmptying(true);
    try {
      const res = await fetchApi(apiPath.teamPasswordsEmptyTrash(teamId), {
        method: "POST",
      });
      if (!res.ok) {
        toast.error(t("failedAction"));
        return;
      }
      toast.success(t("emptyTrashSuccess"));
      setEntries([]);
      clearSelection();
      notifyTeamDataChanged();
    } catch {
      toast.error(t("networkError"));
    } finally {
      setIsEmptying(false);
    }
  };

  const handleDeletePermanently = async (entry: TeamTrashEntry) => {
    try {
      const res = await fetchApi(
        `${apiPath.teamPasswordById(teamId, entry.id)}?permanent=true`,
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

  if (loading) return null;

  if (sortedFiltered.length === 0) {
    return (
      <Card className="rounded-xl border bg-card/80 p-10">
        <div className="flex flex-col items-center justify-center text-center">
          {entries.length === 0 ? (
            <>
              <Trash2 className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <p className="text-muted-foreground">{tl("noTrash")}</p>
            </>
          ) : (
            <p className="text-muted-foreground">{tl("noMatch")}</p>
          )}
        </div>
      </Card>
    );
  }

  const canEmptyTrash = role === TEAM_ROLE.OWNER || role === TEAM_ROLE.ADMIN;

  return (
    <div className="space-y-4">
      {canEmptyTrash && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{t("description")}</p>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm">
                {t("emptyTrash")}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("emptyTrash")}</DialogTitle>
                <DialogDescription>{t("emptyTrashConfirm")}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="destructive" onClick={handleEmptyTrash} disabled={isEmptying}>
                  {isEmptying && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                  {t("emptyTrash")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
      <EntryListShell
        checkboxPlacement="custom"
        entries={sortedFiltered}
        selectionMode={effectiveSelectionMode}
        selectedIds={selectedIds}
        atLimit={atLimit}
        onToggleSelectOne={toggleSelectOne}
        selectEntryLabel={(title) => tl("selectEntry", { title })}
        floatingActions={
          <Button size="sm" onClick={() => requestAction("restore")}>
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            {t("restoreSelected")}
          </Button>
        }
        confirmDialog={{
          open: bulkDialogOpen,
          onOpenChange: setBulkDialogOpen,
          title: pendingAction === "restore" ? t("restoreSelected") : "",
          description: pendingAction === "restore" ? t("bulkRestoreConfirm", { count: selectedIds.size }) : "",
          cancelLabel: tl("cancel"),
          confirmLabel: tl("confirm"),
          processing: bulkProcessing,
          onConfirm: executeAction,
        }}
        renderEntry={(entry, selection: EntrySelectionState | null) => (
          <Card className="py-0 gap-0 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50">
            <CardContent className="flex items-center gap-3 px-4 py-3">
              {selection && (
                <Checkbox
                  checked={selection.checked}
                  disabled={selection.disabled}
                  onCheckedChange={(v) => selection.onCheckedChange(Boolean(v))}
                  aria-label={selection.ariaLabel}
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
                    {teamName}
                  </span>
                </div>
              </div>
              {(role === TEAM_ROLE.OWNER || role === TEAM_ROLE.ADMIN) && (
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
        )}
      />
    </div>
  );
});
