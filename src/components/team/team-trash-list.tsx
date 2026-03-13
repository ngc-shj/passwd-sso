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
import { Building2, Trash2, Loader2, RotateCcw, FileText, CreditCard, IdCard } from "lucide-react";
import { toast } from "sonner";
import { useBulkSelection } from "@/hooks/use-bulk-selection";
import { useBulkAction } from "@/hooks/use-bulk-action";
import { BulkActionConfirmDialog } from "@/components/bulk/bulk-action-confirm-dialog";
import { FloatingActionBar } from "@/components/bulk/floating-action-bar";
import { TEAM_ROLE, ENTRY_TYPE, API_PATH, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { BulkSelectionHandle } from "@/hooks/use-bulk-selection";
import {
  compareEntriesByDeletedAt,
  type EntrySortOption,
} from "@/lib/entry-sort";
import { useTeamVault } from "@/lib/team-vault-context";
import { decryptData } from "@/lib/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto-aad";
import { fetchApi } from "@/lib/url-helpers";

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

export type TeamTrashListHandle = BulkSelectionHandle;

interface TeamTrashListProps {
  teamId?: string;
  searchQuery?: string;
  refreshKey: number;
  sortBy?: EntrySortOption;
  selectionMode?: boolean;
  onSelectedCountChange?: (count: number, allSelected: boolean, atLimit: boolean) => void;
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
    },
    ref,
  ) {
  const t = useTranslations("Trash");
  const tTeam = useTranslations("Team");
  const tl = useTranslations("PasswordList");
  const { getEntryDecryptionKey } = useTeamVault();
  const [entries, setEntries] = useState<TeamTrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [isEmptying, setIsEmptying] = useState(false);

  // Selection only works when scoped to a single team
  const effectiveSelectionMode = scopedTeamId ? (selectionModeProp ?? false) : false;

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchApi(API_PATH.TEAMS_TRASH);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;

      const decrypted = await Promise.all(
        data.map(async (entry: Record<string, unknown>) => {
          try {
            const entryTeamId = entry.teamId as string;
            const entryId = entry.id as string;
            const itemKeyVersion = (entry.itemKeyVersion as number) ?? 0;
            const decryptKey = await getEntryDecryptionKey(entryTeamId, entryId, {
              itemKeyVersion,
              encryptedItemKey: entry.encryptedItemKey as string | undefined,
              itemKeyIv: entry.itemKeyIv as string | undefined,
              itemKeyAuthTag: entry.itemKeyAuthTag as string | undefined,
              teamKeyVersion: (entry.teamKeyVersion as number) ?? 1,
            });
            const aad = buildTeamEntryAAD(entryTeamId, entryId, "overview", itemKeyVersion);
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
  }, [getEntryDecryptionKey]);

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
    scope: { type: "team", teamId: scopedTeamId ?? "" },
    t,
    onSuccess: () => {
      clearSelection();
      fetchTrash();
      window.dispatchEvent(new CustomEvent("team-data-changed"));
    },
  });

  const handleRestore = async (entry: TeamTrashEntry) => {
    try {
      const res = await fetchApi(
        apiPath.teamPasswordRestore(entry.teamId, entry.id),
        { method: "POST" }
      );
      if (res.ok) {
        toast.success(t("restored"));
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
        window.dispatchEvent(new CustomEvent("team-data-changed"));
      } else {
        toast.error(t("failedAction"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleEmptyTrash = async () => {
    if (!scopedTeamId) return;
    setIsEmptying(true);
    try {
      const res = await fetchApi(apiPath.teamPasswordsEmptyTrash(scopedTeamId), {
        method: "POST",
      });
      if (!res.ok) {
        toast.error(t("failedAction"));
        return;
      }
      toast.success(t("emptyTrashSuccess"));
      setEntries([]);
      clearSelection();
    } catch {
      toast.error(t("networkError"));
    } finally {
      setIsEmptying(false);
    }
  };

  const handleDeletePermanently = async (entry: TeamTrashEntry) => {
    try {
      const res = await fetchApi(
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

  if (loading) return null;

  if (sortedFiltered.length === 0) {
    if (entries.length === 0) return null;
    return (
      <div className="mt-6">
        <Card className="rounded-xl border bg-card/80 p-10">
          <div className="flex flex-col items-center justify-center text-center">
            <p className="text-muted-foreground">{tl("noMatch")}</p>
          </div>
        </Card>
      </div>
    );
  }

  // When scoped to a team, derive the user's role from any entry
  const scopedRole = scopedTeamId
    ? entries.find((e) => e.teamId === scopedTeamId)?.role
    : undefined;
  const canEmptyTrash =
    scopedTeamId &&
    (scopedRole === TEAM_ROLE.OWNER || scopedRole === TEAM_ROLE.ADMIN);

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
      {canEmptyTrash && (
        <div className="mb-3 flex items-center justify-between">
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
      <div className={effectiveSelectionMode ? "space-y-2" : "space-y-1"}>
        {sortedFiltered.map((entry) => (
          <Card key={entry.id} className="py-0 gap-0 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50">
            <CardContent className="flex items-center gap-3 px-4 py-3">
              {effectiveSelectionMode && (
                <Checkbox
                  checked={selectedIds.has(entry.id)}
                  disabled={atLimit && !selectedIds.has(entry.id)}
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

      <FloatingActionBar visible={effectiveSelectionMode && selectedIds.size > 0} position="fixed">
        <Button size="sm" onClick={() => requestAction("restore")}>
          <RotateCcw className="h-3.5 w-3.5 mr-1" />
          {t("restoreSelected")}
        </Button>
      </FloatingActionBar>

      <BulkActionConfirmDialog
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        title={pendingAction === "restore" ? t("restoreSelected") : ""}
        description={pendingAction === "restore" ? t("bulkRestoreConfirm", { count: selectedIds.size }) : ""}
        cancelLabel={tl("cancel")}
        confirmLabel={tl("confirm")}
        processing={bulkProcessing}
        onConfirm={executeAction}
      />
    </div>
  );
});
