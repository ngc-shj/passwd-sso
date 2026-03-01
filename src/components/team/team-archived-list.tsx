"use client";

import { useEffect, useState, useCallback, forwardRef } from "react";
import { useTranslations } from "next-intl";
import { PasswordCard } from "@/components/passwords/password-card";
import type { InlineDetailData } from "@/components/passwords/password-detail-inline";
import { TeamPasswordForm } from "@/components/team/team-password-form";
import { Building2, RotateCcw, Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useBulkSelection } from "@/hooks/use-bulk-selection";
import { useBulkAction } from "@/hooks/use-bulk-action";
import { BulkActionConfirmDialog } from "@/components/bulk/bulk-action-confirm-dialog";
import { FloatingActionBar } from "@/components/bulk/floating-action-bar";
import { TEAM_ROLE, API_PATH, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type { EntryCustomField, EntryTotp } from "@/lib/entry-form-types";
import {
  compareEntriesWithFavorite,
  type EntrySortOption,
} from "@/lib/entry-sort";
import { useTeamVault } from "@/lib/team-vault-context";
import { decryptData } from "@/lib/crypto-client";
import { buildTeamEntryAAD } from "@/lib/crypto-aad";

interface TeamArchivedEntry {
  id: string;
  entryType: EntryTypeValue;
  teamId: string;
  teamName: string;
  role: string;
  title: string;
  username: string | null;
  urlHost: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  cardholderName: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
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
  teamId?: string;
  searchQuery: string;
  refreshKey: number;
  sortBy?: EntrySortOption;
  selectionMode?: boolean;
  onSelectedCountChange?: (count: number, allSelected: boolean) => void;
}

export const TeamArchivedList = forwardRef<TeamArchivedListHandle, TeamArchivedListProps>(
  function TeamArchivedList(
    {
      teamId: scopedTeamId,
      searchQuery,
      refreshKey,
      sortBy = "updatedAt",
      selectionMode,
      onSelectedCountChange,
    },
    ref,
  ) {
  const t = useTranslations("Team");
  const tl = useTranslations("PasswordList");
  const { getTeamEncryptionKey } = useTeamVault();
  const [entries, setEntries] = useState<TeamArchivedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTeamId, setEditTeamId] = useState<string | null>(null);
  const [editData, setEditData] = useState<{
    id: string;
    title: string;
    username: string | null;
    password: string;
    url: string | null;
    notes: string | null;
    tags?: { id: string; name: string; color: string | null }[];
    customFields?: EntryCustomField[];
    totp?: EntryTotp | null;
  } | null>(null);

  const effectiveSelectionMode = scopedTeamId ? (selectionMode ?? false) : false;

  const fetchArchived = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(API_PATH.TEAMS_ARCHIVED);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;

      // Decrypt overview blobs (entries span multiple teams)
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
              urlHost: overview.urlHost ?? null,
              snippet: overview.snippet ?? null,
              brand: overview.brand ?? null,
              lastFour: overview.lastFour ?? null,
              cardholderName: overview.cardholderName ?? null,
              fullName: overview.fullName ?? null,
              idNumberLast4: overview.idNumberLast4 ?? null,
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
              entryType: entry.entryType as EntryTypeValue,
              teamId: entry.teamId as string,
              teamName: entry.teamName as string,
              role: entry.role as string,
              title: "(decryption failed)",
              username: null,
              urlHost: null,
              snippet: null,
              brand: null,
              lastFour: null,
              cardholderName: null,
              fullName: null,
              idNumberLast4: null,
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
  }, [getTeamEncryptionKey]);

  useEffect(() => {
    fetchArchived();
  }, [fetchArchived, refreshKey]);

  const filtered = entries.filter((p) => {
    if (scopedTeamId && p.teamId !== scopedTeamId) return false;
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
      p.teamName.toLowerCase().includes(q)
    );
  });

  const sortedFiltered = [...filtered].sort((a, b) =>
    compareEntriesWithFavorite(a, b, sortBy)
  );

  // Bulk selection — uses sortedFiltered (not entries) to fix reconciliation bug
  const entryIds = sortedFiltered.map((e) => e.id);
  const { selectedIds, toggleSelectOne, clearSelection } = useBulkSelection({
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
    scope: { type: "team", teamId: scopedTeamId ?? "" },
    t: tl,
    onSuccess: () => {
      clearSelection();
      fetchArchived();
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleToggleFavorite = async (id: string, _current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, isFavorite: !e.isFavorite } : e))
    );
    try {
      await fetch(apiPath.teamPasswordFavorite(entry.teamId, id), {
        method: "POST",
      });
    } catch {
      fetchArchived();
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleToggleArchive = async (id: string, _current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    // Unarchive: remove from this list
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(apiPath.teamPasswordById(entry.teamId, id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived: false }),
      });
      if (!res.ok) fetchArchived();
    } catch {
      fetchArchived();
    }
  };

  const handleDelete = async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(apiPath.teamPasswordById(entry.teamId, id), {
        method: "DELETE",
      });
      if (!res.ok) fetchArchived();
    } catch {
      fetchArchived();
    }
  };

  const decryptFullBlob = useCallback(
    async (entryTeamId: string, id: string, raw: Record<string, unknown>) => {
      const teamKey = await getTeamEncryptionKey(entryTeamId);
      if (!teamKey) throw new Error("No team key");
      const aad = buildTeamEntryAAD(entryTeamId, id, "blob");
      const json = await decryptData(
        {
          ciphertext: raw.encryptedBlob as string,
          iv: raw.blobIv as string,
          authTag: raw.blobAuthTag as string,
        },
        teamKey,
        aad,
      );
      return JSON.parse(json) as Record<string, unknown>;
    },
    [getTeamEncryptionKey],
  );

  const handleEdit = async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    try {
      const res = await fetch(apiPath.teamPasswordById(entry.teamId, id));
      if (!res.ok) return;
      const raw = await res.json();
      const blob = await decryptFullBlob(entry.teamId, id, raw);
      setEditTeamId(entry.teamId);
      setEditData({
        id: raw.id,
        title: (blob.title as string) ?? "",
        username: (blob.username as string) ?? null,
        password: (blob.password as string) ?? "",
        url: (blob.url as string) ?? null,
        notes: (blob.notes as string) ?? null,
        tags: raw.tags,
        customFields: blob.customFields as EntryCustomField[] | undefined,
        totp: blob.totp as EntryTotp | null | undefined,
      });
      setFormOpen(true);
    } catch {
      // ignore
    }
  };

  const createDetailFetcher = useCallback(
    (entry: TeamArchivedEntry) =>
      async (): Promise<InlineDetailData> => {
        const res = await fetch(apiPath.teamPasswordById(entry.teamId, entry.id));
        if (!res.ok) throw new Error("Failed");
        const raw = await res.json();
        const blob = await decryptFullBlob(entry.teamId, entry.id, raw);
        return {
          id: raw.id,
          entryType: entry.entryType,
          password: (blob.password as string) ?? "",
          content: blob.content as string | undefined,
          url: (blob.url as string) ?? null,
          urlHost: null,
          notes: (blob.notes as string) ?? null,
          customFields: (blob.customFields as EntryCustomField[]) ?? [],
          passwordHistory: [],
          totp: blob.totp as EntryTotp | undefined,
          brand: blob.brand as string | undefined,
          cardholderName: blob.cardholderName as string | undefined,
          cardNumber: blob.cardNumber as string | undefined,
          expiryMonth: blob.expiryMonth as string | undefined,
          expiryYear: blob.expiryYear as string | undefined,
          cvv: blob.cvv as string | undefined,
          fullName: blob.fullName as string | undefined,
          address: blob.address as string | undefined,
          phone: blob.phone as string | undefined,
          email: blob.email as string | undefined,
          dateOfBirth: blob.dateOfBirth as string | undefined,
          nationality: blob.nationality as string | undefined,
          idNumber: blob.idNumber as string | undefined,
          issueDate: blob.issueDate as string | undefined,
          expiryDate: blob.expiryDate as string | undefined,
          relyingPartyId: blob.relyingPartyId as string | undefined,
          relyingPartyName: blob.relyingPartyName as string | undefined,
          username: blob.username as string | undefined,
          credentialId: blob.credentialId as string | undefined,
          creationDate: blob.creationDate as string | undefined,
          deviceInfo: blob.deviceInfo as string | undefined,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        };
      },
    [decryptFullBlob]
  );

  const createPasswordFetcher = useCallback(
    (entry: TeamArchivedEntry) =>
      async (): Promise<string> => {
        const res = await fetch(apiPath.teamPasswordById(entry.teamId, entry.id));
        if (!res.ok) throw new Error("Failed");
        const raw = await res.json();
        const blob = await decryptFullBlob(entry.teamId, entry.id, raw);
        return (blob.password as string) ?? (blob.content as string) ?? "";
      },
    [decryptFullBlob]
  );

  const createUrlFetcher = useCallback(
    (entry: TeamArchivedEntry) =>
      async (): Promise<string | null> => {
        const res = await fetch(apiPath.teamPasswordById(entry.teamId, entry.id));
        if (!res.ok) throw new Error("Failed");
        const raw = await res.json();
        const blob = await decryptFullBlob(entry.teamId, entry.id, raw);
        return (blob.url as string) ?? null;
      },
    [decryptFullBlob]
  );

  if (loading || sortedFiltered.length === 0) return null;

  return (
    <div className="mt-6">
      {!scopedTeamId && (
        <div className="mb-3 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("archive")}
          </h2>
        </div>
      )}
      <div className="space-y-2">
        {sortedFiltered.map((entry) =>
          effectiveSelectionMode ? (
            <div key={entry.id} className="flex items-start gap-2">
              <Checkbox
                className="mt-4"
                checked={selectedIds.has(entry.id)}
                onCheckedChange={(v) => toggleSelectOne(entry.id, Boolean(v))}
                aria-label={tl("selectEntry", { title: entry.title })}
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
                  tags={entry.tags}
                  isFavorite={entry.isFavorite}
                  isArchived={entry.isArchived}
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
                  canEdit={entry.role === TEAM_ROLE.OWNER || entry.role === TEAM_ROLE.ADMIN || entry.role === TEAM_ROLE.MEMBER}
                  canDelete={entry.role === TEAM_ROLE.OWNER || entry.role === TEAM_ROLE.ADMIN}
                  createdBy={entry.teamName}
                  teamId={entry.teamId}
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
              tags={entry.tags}
              isFavorite={entry.isFavorite}
              isArchived={entry.isArchived}
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
              canEdit={entry.role === TEAM_ROLE.OWNER || entry.role === TEAM_ROLE.ADMIN || entry.role === TEAM_ROLE.MEMBER}
              canDelete={entry.role === TEAM_ROLE.OWNER || entry.role === TEAM_ROLE.ADMIN}
              createdBy={entry.teamName}
              teamId={entry.teamId}
            />
          )
        )}
      </div>

      <FloatingActionBar visible={effectiveSelectionMode && selectedIds.size > 0} position="fixed">
        <Button variant="secondary" size="sm" onClick={() => requestAction("unarchive")}>
          <RotateCcw className="mr-1 h-4 w-4" />
          {tl("moveSelectedToUnarchive")}
        </Button>
        <Button variant="destructive" size="sm" onClick={() => requestAction("trash")}>
          <Trash2 className="mr-1 h-4 w-4" />
          {tl("moveSelectedToTrash")}
        </Button>
      </FloatingActionBar>

      <BulkActionConfirmDialog
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        title={
          pendingAction === "unarchive"
            ? tl("moveSelectedToUnarchive")
            : tl("moveSelectedToTrash")
        }
        description={
          pendingAction === "unarchive"
            ? tl("bulkUnarchiveConfirm", { count: selectedIds.size })
            : tl("bulkMoveConfirm", { count: selectedIds.size })
        }
        cancelLabel={tl("cancel")}
        confirmLabel={tl("confirm")}
        processing={bulkProcessing}
        onConfirm={() => void executeAction()}
      />

      {editTeamId && (
        <TeamPasswordForm
          teamId={editTeamId}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={() => {
            fetchArchived();
            setExpandedId(null);
          }}
          editData={editData}
        />
      )}
    </div>
  );
});
