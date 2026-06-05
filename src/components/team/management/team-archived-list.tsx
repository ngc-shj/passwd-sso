"use client";

import { useEffect, useState, useCallback, forwardRef } from "react";
import { useTranslations } from "next-intl";
import { PasswordCard } from "@/components/passwords/detail/password-card";
import { PasswordRow } from "@/components/passwords/detail/password-row";
import { MasterDetailShell } from "@/components/passwords/detail/master-detail-shell";
import { PasswordDetailPane } from "@/components/passwords/detail/password-detail-pane";
import { buildTeamGetDetail } from "@/lib/vault/build-team-get-detail";
import { TeamEditDialogLoader } from "@/components/team/management/team-edit-dialog-loader";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBulkSelection } from "@/hooks/bulk/use-bulk-selection";
import { useBulkAction } from "@/hooks/bulk/use-bulk-action";
import { EntryListShell } from "@/components/bulk/entry-list-shell";
import { TEAM_ROLE, VAULT_STATUS, ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import {
  compareEntriesWithFavorite,
  type EntrySortOption,
} from "@/lib/vault/entry-sort";
import { useTeamVault } from "@/lib/team/team-vault-context";
import { decryptData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { usePasswordEntryDetail } from "@/hooks/vault/use-password-entry-detail";
import { useEntryActions } from "@/hooks/vault/use-entry-actions";

interface TeamArchivedEntry {
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
  isFavorite: boolean;
  isArchived: boolean;
  tags: { id: string; name: string; color: string | null }[];
  createdBy: { id: string; name: string | null; email: string | null; image: string | null };
  updatedBy: { id: string; name: string | null; email: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface TeamArchivedListHandle {
  toggleSelectAll: (checked: boolean) => void;
}

interface TeamArchivedListProps {
  teamId: string;
  teamName: string;
  role: string;
  searchQuery: string;
  refreshKey: number;
  sortBy?: EntrySortOption;
  selectionMode?: boolean;
  onSelectedCountChange?: (count: number, allSelected: boolean, atLimit: boolean) => void;
}

export const TeamArchivedList = forwardRef<TeamArchivedListHandle, TeamArchivedListProps>(
  function TeamArchivedList(
    {
      teamId,
      teamName,
      role,
      searchQuery,
      refreshKey,
      sortBy = "updatedAt",
      selectionMode,
      onSelectedCountChange,
    },
    ref,
  ) {
  const tl = useTranslations("PasswordList");
  const { getEntryDecryptionKey } = useTeamVault();
  const layoutMode = useLayoutMode();
  const [entries, setEntries] = useState<TeamArchivedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTeamId, setEditTeamId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);

  // Active entry for 3-pane detail pane (master-detail mode only).
  const [activeEntry, setActiveEntry] = useState<TeamArchivedEntry | null>(null);

  const effectiveSelectionMode = selectionMode ?? false;

  const roleCanEdit = role === TEAM_ROLE.OWNER || role === TEAM_ROLE.ADMIN || role === TEAM_ROLE.MEMBER;
  const roleCanDelete = role === TEAM_ROLE.OWNER || role === TEAM_ROLE.ADMIN;

  const fetchArchived = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchApi(`${apiPath.teamPasswords(teamId)}?archived=true`);
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data)) return;

      // Decrypt overview blobs
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
              isFavorite: entry.isFavorite,
              isArchived: entry.isArchived,
              tags: entry.tags,
              createdBy: entry.createdBy,
              updatedBy: entry.updatedBy,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
            } as TeamArchivedEntry;
          } catch {
            return {
              id: entry.id as string,
              entryType: (entry.entryType ?? ENTRY_TYPE.LOGIN) as EntryTypeValue,
              title: "(decryption failed)",
              username: null,
              urlHost: null,
              snippet: null,
              brand: null,
              lastFour: null,
              cardholderName: null,
              fullName: null,
              idNumberLast4: null,
              relyingPartyId: null,
              bankName: null,
              accountNumberLast4: null,
              softwareName: null,
              licensee: null,
              keyType: null,
              fingerprint: null,
              isFavorite: entry.isFavorite as boolean,
              isArchived: entry.isArchived as boolean,
              tags: (entry.tags ?? []) as TeamArchivedEntry["tags"],
              createdBy: entry.createdBy as TeamArchivedEntry["createdBy"],
              updatedBy: entry.updatedBy as TeamArchivedEntry["updatedBy"],
              createdAt: entry.createdAt as string,
              updatedAt: entry.updatedAt as string,
            } as TeamArchivedEntry;
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
    fetchArchived();
  }, [fetchArchived, refreshKey]);

  const filtered = entries.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.title.toLowerCase().includes(q) ||
      p.username?.toLowerCase().includes(q) ||
      p.urlHost?.toLowerCase().includes(q) ||
      p.snippet?.toLowerCase().includes(q) ||
      p.fullName?.toLowerCase().includes(q) ||
      p.idNumberLast4?.includes(q) ||
      p.brand?.toLowerCase().includes(q) ||
      p.lastFour?.includes(q) ||
      p.cardholderName?.toLowerCase().includes(q) ||
      teamName.toLowerCase().includes(q)
    );
  });

  const sortedFiltered = [...filtered].sort((a, b) =>
    compareEntriesWithFavorite(a, b, sortBy)
  );

  // Bulk selection — uses sortedFiltered (not entries) to fix reconciliation bug
  const entryIds = sortedFiltered.map((e) => e.id);
  const { selectedIds, atLimit, toggleSelectOne, clearSelection } = useBulkSelection({
    entryIds,
    selectionMode: effectiveSelectionMode,
    selectAllRef: ref,
    onSelectedCountChange,
  });

  // Bulk action
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
    t: tl,
    onSuccess: () => {
      clearSelection();
      fetchArchived();
    },
  });

  const handleToggleFavorite = async (id: string, _current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, isFavorite: !e.isFavorite } : e))
    );
    try {
      await fetchApi(apiPath.teamPasswordFavorite(teamId, id), {
        method: "POST",
      });
    } catch {
      fetchArchived();
    }
  };

  // Unarchive/restore a single entry — removes it from the archive list.
  const handleToggleArchive = async (id: string, _current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    if (activeEntry?.id === id) setActiveEntry(null);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetchApi(apiPath.teamPasswordById(teamId, id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: false }),
      });
      if (!res.ok) fetchArchived();
    } catch {
      fetchArchived();
    }
    notifyTeamDataChanged();
  };

  const handleDelete = async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    if (activeEntry?.id === id) setActiveEntry(null);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetchApi(apiPath.teamPasswordById(teamId, id), {
        method: "DELETE",
      });
      if (!res.ok) fetchArchived();
    } catch {
      fetchArchived();
    }
    notifyTeamDataChanged();
  };

  const decryptFullBlob = useCallback(
    async (id: string, raw: Record<string, unknown>) => {
      const itemKeyVersion = (raw.itemKeyVersion as number) ?? 0;
      const decryptKey = await getEntryDecryptionKey(teamId, id, {
        itemKeyVersion,
        encryptedItemKey: raw.encryptedItemKey as string | undefined,
        itemKeyIv: raw.itemKeyIv as string | undefined,
        itemKeyAuthTag: raw.itemKeyAuthTag as string | undefined,
        teamKeyVersion: (raw.teamKeyVersion as number) ?? 1,
      });
      const aad = buildTeamEntryAAD(teamId, id, "blob", itemKeyVersion);
      const json = await decryptData(
        {
          ciphertext: raw.encryptedBlob as string,
          iv: raw.blobIv as string,
          authTag: raw.blobAuthTag as string,
        },
        decryptKey,
        aad,
      );
      return JSON.parse(json) as Record<string, unknown>;
    },
    [teamId, getEntryDecryptionKey],
  );

  const handleEdit = (id: string) => {
    setEditTeamId(teamId);
    setEditEntryId(id);
    setFormOpen(true);
  };

  const createDetailFetcher = useCallback(
    (entry: TeamArchivedEntry) =>
      buildTeamGetDetail(teamId, { id: entry.id, entryType: entry.entryType }, { getEntryDecryptionKey }),
    [teamId, getEntryDecryptionKey]
  );

  const createPasswordFetcher = useCallback(
    (entry: TeamArchivedEntry) =>
      async (): Promise<string> => {
        const res = await fetchApi(apiPath.teamPasswordById(teamId, entry.id));
        if (!res.ok) {
          throw new Error("Failed");
        }
        const raw = await res.json();
        const blob = await decryptFullBlob(entry.id, raw);
        return (blob.password as string) ?? (blob.content as string) ?? "";
      },
    [teamId, decryptFullBlob]
  );

  const createUrlFetcher = useCallback(
    (entry: TeamArchivedEntry) =>
      async (): Promise<string | null> => {
        const res = await fetchApi(apiPath.teamPasswordById(teamId, entry.id));
        if (!res.ok) {
          throw new Error("Failed");
        }
        const raw = await res.json();
        const blob = await decryptFullBlob(entry.id, raw);
        return (blob.url as string) ?? null;
      },
    [teamId, decryptFullBlob]
  );

  // Detail hook for the active entry in master-detail mode.
  // Archived entries are already decrypted (list renders after decrypt), so vault
  // status is always UNLOCKED for the purpose of this pane.
  const archGetDetail = useCallback(
    (_id: string) =>
      activeEntry
        ? createDetailFetcher(activeEntry)()
        : Promise.reject(new Error("no active entry")),
    [activeEntry, createDetailFetcher],
  );

  const {
    detailData: archDetailData,
    loading: archDetailLoading,
    error: archDetailError,
  } = usePasswordEntryDetail(activeEntry?.id ?? null, {
    getDetail: archGetDetail,
    vaultStatus: VAULT_STATUS.UNLOCKED,
  });

  // Row callbacks for master-detail rows.
  const buildArchivedRowCallbacks = useEntryActions((entry: TeamArchivedEntry) =>
    createDetailFetcher(entry),
  );

  if (loading) return null;

  if (sortedFiltered.length === 0) {
    return (
      <Card className="rounded-xl border bg-card/80 p-10">
        <div className="flex flex-col items-center justify-center text-center">
          {entries.length === 0 ? (
            <>
              <Archive className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <p className="text-muted-foreground">{tl("noArchive")}</p>
            </>
          ) : (
            <p className="text-muted-foreground">{tl("noMatch")}</p>
          )}
        </div>
      </Card>
    );
  }

  const floatingBulkActions = (
    <>
      <Button variant="secondary" size="sm" onClick={() => requestAction("unarchive")}>
        <RotateCcw className="mr-1 h-4 w-4" />
        {tl("moveSelectedToUnarchive")}
      </Button>
      <Button variant="destructive" size="sm" onClick={() => requestAction("trash")}>
        <Trash2 className="mr-1 h-4 w-4" />
        {tl("moveSelectedToTrash")}
      </Button>
    </>
  );

  const bulkConfirmDialog = {
    open: bulkDialogOpen,
    onOpenChange: setBulkDialogOpen,
    title:
      pendingAction === "unarchive"
        ? tl("moveSelectedToUnarchive")
        : tl("moveSelectedToTrash"),
    description:
      pendingAction === "unarchive"
        ? tl("bulkUnarchiveConfirm", { count: selectedIds.size })
        : tl("bulkMoveConfirm", { count: selectedIds.size }),
    cancelLabel: tl("cancel"),
    confirmLabel: tl("confirm"),
    processing: bulkProcessing,
    onConfirm: () => void executeAction(),
  };

  const editDialog = editTeamId && editEntryId ? (
    <TeamEditDialogLoader
      teamId={editTeamId}
      id={editEntryId}
      open={formOpen}
      onOpenChange={setFormOpen}
      onSaved={() => {
        fetchArchived();
        setExpandedId(null);
        notifyTeamDataChanged();
      }}
    />
  ) : null;

  if (layoutMode === "master-detail") {
    return (
      <div className="h-full min-h-0">
        <MasterDetailShell
          layoutMode={layoutMode}
          activeEntryId={activeEntry?.id ?? null}
          listSlot={
            <div className="space-y-1 p-2">
              <EntryListShell
                entries={sortedFiltered}
                selectionMode={effectiveSelectionMode}
                selectedIds={selectedIds}
                atLimit={atLimit}
                onToggleSelectOne={toggleSelectOne}
                selectEntryLabel={(title) => tl("selectEntry", { title })}
                floatingActions={floatingBulkActions}
                confirmDialog={bulkConfirmDialog}
                renderEntry={(entry) => (
                  <PasswordRow
                    entry={entry}
                    isActive={activeEntry?.id === entry.id}
                    onActivate={() =>
                      setActiveEntry((prev) =>
                        prev?.id === entry.id ? null : entry
                      )
                    }
                    selectionMode={effectiveSelectionMode}
                    {...buildArchivedRowCallbacks(entry)}
                    onShare={() => setActiveEntry(entry)}
                    onEdit={() => handleEdit(entry.id)}
                    onToggleArchive={() => void handleToggleArchive(entry.id, entry.isArchived)}
                    onDeleteRequest={() => void handleDelete(entry.id)}
                    canEdit={roleCanEdit}
                    canDelete={roleCanDelete}
                    canShare={roleCanEdit}
                  />
                )}
              />
            </div>
          }
          detailSlot={
            effectiveSelectionMode ? (
              <div className="flex h-full items-center justify-center py-16 text-sm text-muted-foreground">
                {tl("selectedCount", { count: selectedIds.size })}
              </div>
            ) : (
              <PasswordDetailPane
                key={activeEntry?.id ?? "none"}
                entryId={activeEntry?.id ?? null}
                entry={activeEntry}
                detailData={archDetailData}
                loading={archDetailLoading}
                error={archDetailError}
                onEdit={activeEntry ? () => handleEdit(activeEntry.id) : undefined}
                onRefresh={() => fetchArchived()}
                teamId={teamId}
                readOnly={!roleCanEdit}
              />
            )
          }
        />
        {editDialog}
      </div>
    );
  }

  // Accordion mode (< lg): existing PasswordCard list, unchanged behavior.
  return (
    <EntryListShell
      entries={sortedFiltered}
      selectionMode={effectiveSelectionMode}
      selectedIds={selectedIds}
      atLimit={atLimit}
      onToggleSelectOne={toggleSelectOne}
      selectEntryLabel={(title) => tl("selectEntry", { title })}
      renderEntry={(entry) => (
        <PasswordCard
          entry={entry}
          expanded={expandedId === entry.id}
          onToggleFavorite={handleToggleFavorite}
          onToggleArchive={handleToggleArchive}
          onDelete={handleDelete}
          onToggleExpand={(id) =>
            setExpandedId((prev) => (prev === id ? null : id))
          }
          onRefresh={() => {
            fetchArchived();
            setExpandedId(null);
          }}
          getPassword={createPasswordFetcher(entry)}
          getDetail={createDetailFetcher(entry)}
          getUrl={createUrlFetcher(entry)}
          onEditClick={() => handleEdit(entry.id)}
          canEdit={roleCanEdit}
          canDelete={roleCanDelete}
          createdBy={teamName}
          teamId={teamId}
        />
      )}
      floatingActions={floatingBulkActions}
      confirmDialog={bulkConfirmDialog}
    >
      {editDialog}
    </EntryListShell>
  );
});
