"use client";

/**
 * C3 — EntryListView shared component.
 *
 * Vault-agnostic orchestration layer extracted from PasswordList + dashboard
 * wiring. Owns activeEntry, selectionMode, useEntryListData, usePasswordEntryDetail,
 * useEntryActions, useBulkSelection, useBulkAction, and MasterDetailShell wiring.
 *
 * FORBIDDEN in this file (C1/C3 contracts):
 *   - useVault()         — vault access only through the adapter
 *   - /api/passwords     — API paths belong to adapters
 *   - getEntryDecryptionKey — team decryption belongs to the team adapter only
 */

import { useState, useMemo, useEffect, useCallback, useImperativeHandle, useRef } from "react";
import type { Ref, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Archive, KeyRound, Loader2, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { VaultListAdapter, EntryListQuery } from "@/lib/vault/vault-list-adapter";
import type { ListViewDescriptor } from "@/components/passwords/detail/entry-list-view-descriptors";
import type { PasswordRowEntry } from "@/components/passwords/detail/password-row";
import type { PasswordDetailPaneEntry } from "@/components/passwords/detail/password-detail-pane";
import type { EntrySortOption } from "@/lib/vault/entry-sort";

import { useEntryListData } from "@/hooks/vault/use-entry-list-data";
import { usePasswordEntryDetail } from "@/hooks/vault/use-password-entry-detail";
import { useEntryActions } from "@/hooks/vault/use-entry-actions";
import { useBulkSelection } from "@/hooks/bulk/use-bulk-selection";
import { useBulkAction } from "@/hooks/bulk/use-bulk-action";
import { MasterDetailShell } from "@/components/passwords/detail/master-detail-shell";
import type { EntryCardData } from "@/types/entry-card";
import { PasswordDetailPane } from "@/components/passwords/detail/password-detail-pane";
import { PasswordRow } from "@/components/passwords/detail/password-row";
import { PasswordCard } from "@/components/passwords/detail/password-card";
import { EntryListShell } from "@/components/bulk/entry-list-shell";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { VAULT_STATUS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// EntryListHandle — imperative handle for parent (header "Select" button).
// ---------------------------------------------------------------------------

export interface EntryListHandle {
  enterSelectionMode(): void;
  exitSelectionMode(): void;
  toggleSelectAll(checked: boolean): void;
}

// ---------------------------------------------------------------------------
// EntryListView props
// ---------------------------------------------------------------------------

interface EntryListViewProps<E extends PasswordRowEntry & PasswordDetailPaneEntry> {
  adapter: VaultListAdapter<E>;
  descriptor: ListViewDescriptor;
  query: EntryListQuery;
  searchQuery: string;
  sortBy: EntrySortOption;
  refreshKey: number;
  onSelectedCountChange?: (count: number, allSelected: boolean, atLimit: boolean) => void;
  listRef?: Ref<EntryListHandle>;
  onDataChange?: () => void;
  onRequestEdit?: (entry: E) => void;
  onRequestShare?: (entry: E) => void;
  onEntryRemoved?: (id: string) => void;
  onVisibleEntriesChange?: (entries: E[]) => void;
}

// ---------------------------------------------------------------------------
// INV-DEV1 — dev-time assertion: no enabled descriptor action lacks adapter support.
// Gated by NODE_ENV !== "production" so it runs under Vitest.
// ---------------------------------------------------------------------------
function assertDescriptorAdapterCompat<E extends PasswordRowEntry & PasswordDetailPaneEntry>(
  descriptor: ListViewDescriptor,
  adapter: VaultListAdapter<E>,
): void {
  if (process.env.NODE_ENV === "production") return;

  if (descriptor.rowActions.favorite && !adapter.supportsFavorite) {
    throw new Error(
      `INV-DEV1: descriptor "${descriptor.kind}" enables rowActions.favorite but adapter.supportsFavorite=false`,
    );
  }
}

// ---------------------------------------------------------------------------
// EntryListView
// ---------------------------------------------------------------------------

/**
 * Shared vault-agnostic entry list component (C3).
 *
 * Owns: activeEntry, selectionMode, useEntryListData, usePasswordEntryDetail,
 * useEntryActions, useBulkSelection, useBulkAction, MasterDetailShell wiring.
 *
 * Does NOT own: dialogs (hosted by the container via onRequestEdit/onRequestShare),
 * vault unlock, vault key, or any API path.
 */
export function EntryListView<E extends PasswordRowEntry & PasswordDetailPaneEntry>({
  adapter,
  descriptor,
  query,
  searchQuery,
  sortBy,
  refreshKey,
  onSelectedCountChange,
  listRef,
  onDataChange,
  onRequestEdit,
  onRequestShare,
  onEntryRemoved,
  onVisibleEntriesChange,
}: EntryListViewProps<E>) {
  const t = useTranslations("PasswordList");
  const tTrash = useTranslations("Trash");
  const layoutMode = useLayoutMode();

  // INV-DEV1: assert descriptor × adapter compatibility on mount + when they change.
  useEffect(() => {
    assertDescriptorAdapterCompat(descriptor, adapter);
  }, [descriptor, adapter]);

  // INV-F1 / INV-S5: activeEntry AND selectionMode — owned here, reset atomically on query/view change.
  const [activeEntry, setActiveEntry] = useState<E | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);

  // C9 — delete-permanently confirm dialog state (INV-C9.2: confirm before DELETE).
  const [deletePermanentlyPending, setDeletePermanentlyPending] = useState<E | null>(null);

  // Empty-trash confirm dialog state (shown when descriptor.showEmptyTrashButton is true).
  const [emptyTrashConfirmOpen, setEmptyTrashConfirmOpen] = useState(false);
  const [isEmptyingTrash, setIsEmptyingTrash] = useState(false);

  // INV-F1: detect query/descriptor.kind changes and clear both atomically during render.
  const viewKey = `${descriptor.kind}|${query.tagId ?? ""}|${query.folderId ?? ""}|${query.entryType ?? ""}`;
  const [prevViewKey, setPrevViewKey] = useState(viewKey);
  if (prevViewKey !== viewKey) {
    setPrevViewKey(viewKey);
    setActiveEntry(null);
    setSelectionMode(false);
  }

  // C4 hook — fetch/decrypt/sort/search/abort.
  const { entries, loading, error: _listError, reload } = useEntryListData({
    adapter,
    view: descriptor.kind,
    query,
    searchQuery,
    sortBy,
    refreshKey,
    sort: descriptor.sort,
  });

  // INV-S3: derive vaultStatus from adapter.availability (S3 — same signal for list + pane).
  const vaultStatus = adapter.availability.ready ? VAULT_STATUS.UNLOCKED : VAULT_STATUS.LOADING;

  // Build the getDetail closure for the active entry (LAZY — INV-S1/S4).
  // The closure is built from adapter.buildGetDetail(activeEntry) but NOT invoked here;
  // usePasswordEntryDetail invokes it only when entryId is non-null and vault is UNLOCKED.
  // Not manually memoized — usePasswordEntryDetail stores it in a ref and only calls it
  // on entryId/invalidate change, so a fresh closure per render is harmless (and the
  // React Compiler handles memoization).
  const getDetailForHook = activeEntry
    ? (_id: string) => adapter.buildGetDetail(activeEntry)()
    : async (_id: string): Promise<never> => { throw new Error("No active entry"); };

  // C1 hook — manages fetch/decrypt lifecycle for the active entry in the detail pane.
  const {
    detailData,
    loading: detailLoading,
    error: detailError,
    invalidate: invalidateDetail,
  } = usePasswordEntryDetail(
    // INV-S5: when selectionMode, pass null so no decrypt occurs.
    selectionMode ? null : (activeEntry?.id ?? null),
    { getDetail: getDetailForHook, vaultStatus },
  );

  // INV-S1/S4: LAZY row callbacks — useEntryActions is given a factory function;
  // the factory is called per row (creating closures), but the closures themselves
  // are only invoked on explicit user copy/reveal events.
  const buildRowCallbacks = useEntryActions((entry: E) => adapter.buildGetDetail(entry));

  // Notify parent of visible entry list changes (keyboard nav support).
  useEffect(() => {
    onVisibleEntriesChange?.(entries);
  }, [entries, onVisibleEntriesChange]);

  // Refresh the open detail pane when the container signals external data change
  // (e.g. an edit dialog saved). refreshKey bumps on every reload; invalidate is a
  // no-op when no entry is active, so re-decrypt only happens for the active entry.
  useEffect(() => {
    invalidateDetail();
  }, [refreshKey, invalidateDetail]);

  // ── Keyboard navigation (master-detail only) — owned here so every view (incl.
  // trash/team) gets arrow-nav, not just the personal dashboard (commonization). ──
  const arrowNavDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (arrowNavDebounceRef.current) clearTimeout(arrowNavDebounceRef.current);
  }, []);

  const handleListKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (layoutMode !== "master-detail") return;
    if (selectionMode) return; // INV-C4.4

    const target = e.target as HTMLElement;
    const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    if (e.key === "Escape") {
      listPaneRef.current?.focus();
      e.stopPropagation();
      return;
    }
    if (inInput) return; // INV-C7.2

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const direction = e.key;
      if (arrowNavDebounceRef.current) clearTimeout(arrowNavDebounceRef.current);
      // Debounce (~150ms) so holding ↓ doesn't fire N concurrent getDetail calls (INV-C7.4).
      arrowNavDebounceRef.current = setTimeout(() => {
        arrowNavDebounceRef.current = null;
        const currentIdx = activeEntry ? entries.findIndex((en) => en.id === activeEntry.id) : -1;
        const nextIdx = direction === "ArrowDown"
          ? Math.min(currentIdx + 1, entries.length - 1)
          : Math.max(currentIdx - 1, 0);
        const next = entries[nextIdx];
        if (next) setActiveEntry(next);
      }, 150);
      return;
    }

    if (e.key === "Enter" || e.key === "Tab") {
      const detailEl = listPaneRef.current?.parentElement?.querySelector<HTMLElement>(
        "[data-testid='master-detail-detail']",
      );
      detailEl?.focus();
      e.preventDefault();
    }
  }, [layoutMode, selectionMode, entries, activeEntry]);

  // Bulk selection — uses all visible entries for selection.
  const entryIds = useMemo(() => entries.map((e) => e.id), [entries]);

  const handleSelectedCountChange = useCallback(
    (count: number, allSelected: boolean, atLimit: boolean) => {
      onSelectedCountChange?.(count, allSelected, atLimit);
    },
    [onSelectedCountChange],
  );

  const { selectedIds, atLimit, toggleSelectOne, toggleSelectAll, clearSelection } = useBulkSelection({
    entryIds,
    selectionMode,
    onSelectedCountChange: handleSelectedCountChange,
  });

  // Expose imperative handle to parent (F9). Reference toggleSelectAll directly —
  // re-creating the handle when it changes is cheap (no setState, no render loop).
  // (Storing it in state via an effect looped when the hook returns a fresh
  // toggleSelectAll each render.)
  useImperativeHandle(
    listRef,
    () => ({
      enterSelectionMode: () => {
        setSelectionMode(true);
        setActiveEntry(null);
      },
      exitSelectionMode: () => {
        setSelectionMode(false);
      },
      toggleSelectAll: (checked: boolean) => {
        toggleSelectAll(checked);
      },
    }),
    [toggleSelectAll],
  );

  // Bulk action hook.
  const {
    dialogOpen: bulkDialogOpen,
    setDialogOpen: setBulkDialogOpen,
    pendingAction,
    processing: bulkProcessing,
    requestAction,
    executeAction,
  } = useBulkAction({
    selectedIds,
    scope: adapter.bulkScope(descriptor.kind),
    t,
    onSuccess: () => {
      clearSelection();
      reload();
      onDataChange?.();
    },
  });

  // ── Single-entry mutation handlers (INV-C1.4) ──────────────────────────────
  // Each: (1) optimistic remove, (2) adapter call, (3) rollback on reject, (4) notify on success.

  const handleSetFavorite = useCallback(async (entry: E, next: boolean) => {
    // INV-C1.4 + F8: for favorites view, unfavoriting removes the row.
    const removesRow = descriptor.removeOnUnfavorite && !next;
    if (removesRow) {
      setActiveEntry((prev) => (prev?.id === entry.id ? null : prev));
      onEntryRemoved?.(entry.id);
    }
    try {
      await adapter.setFavorite(entry, next);
      adapter.notifyDataChanged();
      onDataChange?.();
    } catch {
      reload();
    }
  }, [adapter, descriptor.removeOnUnfavorite, onDataChange, onEntryRemoved, reload]);

  const handleSetArchived = useCallback(async (entry: E, next: boolean) => {
    // Archive/unarchive always removes from the current view.
    setActiveEntry((prev) => (prev?.id === entry.id ? null : prev));
    onEntryRemoved?.(entry.id);
    try {
      await adapter.setArchived(entry, next);
      adapter.notifyDataChanged();
      onDataChange?.();
    } catch {
      reload();
    }
  }, [adapter, onDataChange, onEntryRemoved, reload]);

  const handleSoftDelete = useCallback(async (entry: E) => {
    setActiveEntry((prev) => (prev?.id === entry.id ? null : prev));
    onEntryRemoved?.(entry.id);
    try {
      await adapter.softDelete(entry);
      adapter.notifyDataChanged();
      onDataChange?.();
    } catch {
      reload();
    }
  }, [adapter, onDataChange, onEntryRemoved, reload]);

  // C9 — restore (no confirm per INV-C9.2).
  const handleRestore = useCallback(async (entry: E) => {
    setActiveEntry((prev) => (prev?.id === entry.id ? null : prev));
    onEntryRemoved?.(entry.id);
    try {
      await adapter.restore(entry);
      adapter.notifyDataChanged();
      onDataChange?.();
    } catch {
      reload();
    }
  }, [adapter, onDataChange, onEntryRemoved, reload]);

  // C9 — delete permanently (confirm dialog shown first; this is called on confirm).
  const handleDeletePermanentlyConfirmed = useCallback(async () => {
    const entry = deletePermanentlyPending;
    if (!entry) return;
    setDeletePermanentlyPending(null);
    setActiveEntry((prev) => (prev?.id === entry.id ? null : prev));
    onEntryRemoved?.(entry.id);
    try {
      await adapter.deletePermanently(entry);
      adapter.notifyDataChanged();
      onDataChange?.();
    } catch {
      reload();
    }
  }, [adapter, deletePermanentlyPending, onDataChange, onEntryRemoved, reload]);

  // Empty-trash: clears all trash entries; gated by descriptor.showEmptyTrashButton + canDelete.
  const handleEmptyTrashConfirmed = useCallback(async () => {
    setIsEmptyingTrash(true);
    try {
      await adapter.emptyTrash();
      setEmptyTrashConfirmOpen(false);
      adapter.notifyDataChanged();
      onDataChange?.();
      reload();
    } catch {
      // Reload to show remaining entries on failure.
      reload();
    } finally {
      setIsEmptyingTrash(false);
    }
  }, [adapter, onDataChange, reload]);

  // ── Accordion toggle callbacks (legacy PasswordCard interface) ─────────────

  const handleCardToggleFavorite = useCallback(async (id: string, current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    await handleSetFavorite(entry, !current);
  }, [entries, handleSetFavorite]);

  const handleCardToggleArchive = useCallback(async (id: string, current: boolean) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    await handleSetArchived(entry, !current);
  }, [entries, handleSetArchived]);

  const handleCardDelete = useCallback(async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    await handleSoftDelete(entry);
  }, [entries, handleSoftDelete]);

  const handleToggleExpand = useCallback((id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (activeEntry?.id === id) {
      setActiveEntry(null);
    } else if (entry) {
      setActiveEntry(entry);
    }
  }, [entries, activeEntry]);

  // ── Render helpers ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Gate: show locked/unavailable card when adapter not ready.
  if (!adapter.availability.ready) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <KeyRound className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <p className="text-muted-foreground">{t("selectAnEntry")}</p>
      </div>
    );
  }

  if (entries.length === 0) {
    const emptyIcon =
      descriptor.kind === "archive" ? (
        <Archive className="h-12 w-12 text-muted-foreground/50 mb-4" />
      ) : descriptor.kind === "favorites" ? (
        <Star className="h-12 w-12 text-muted-foreground/50 mb-4" />
      ) : descriptor.kind === "trash" ? (
        <Trash2 className="h-12 w-12 text-muted-foreground/50 mb-4" />
      ) : (
        <KeyRound className="h-12 w-12 text-muted-foreground/50 mb-4" />
      );

    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        {emptyIcon}
        <p className="text-muted-foreground">
          {searchQuery ? t("noMatch") : t(descriptor.emptyStateKey as Parameters<typeof t>[0])}
        </p>
        {descriptor.kind === "normal" && !searchQuery && (
          <p className="text-sm text-muted-foreground mt-1">{t("addFirst")}</p>
        )}
      </div>
    );
  }

  // ── Bulk action bar buttons ─────────────────────────────────────────────────

  // Bulk buttons are always rendered in selection mode and enabled only when
  // 1+ entries are selected (disabled = inactive otherwise).
  const noneSelected = selectedIds.size === 0;
  const floatingActions = (
    <>
      {descriptor.bulkActions.includes("archive") && (
        <Button variant="secondary" size="sm" disabled={noneSelected} onClick={() => requestAction("archive")}>
          {t("moveSelectedToArchive")}
        </Button>
      )}
      {descriptor.bulkActions.includes("unarchive") && (
        <Button variant="secondary" size="sm" disabled={noneSelected} onClick={() => requestAction("unarchive")}>
          {t("moveSelectedToUnarchive")}
        </Button>
      )}
      {descriptor.bulkActions.includes("trash") && (
        <Button variant="destructive" size="sm" disabled={noneSelected} onClick={() => requestAction("trash")}>
          {t("moveSelectedToTrash")}
        </Button>
      )}
      {descriptor.bulkActions.includes("restore") && (
        <Button variant="secondary" size="sm" disabled={noneSelected} onClick={() => requestAction("restore")}>
          {tTrash("restoreSelected")}
        </Button>
      )}
      {descriptor.bulkActions.includes("deletePermanently") && (
        <Button variant="destructive" size="sm" disabled={noneSelected} onClick={() => requestAction("deletePermanently")}>
          {tTrash("deleteSelectedPermanently")}
        </Button>
      )}
    </>
  );

  // Empty-trash button — shown when descriptor opts in and canDelete is true.
  const showEmptyTrashButton =
    descriptor.showEmptyTrashButton && adapter.permissions.canDelete;

  // In master-detail, the empty-trash description + action live in the detail pane's
  // no-selection state (below) rather than crowding the narrow list (matches the
  // bulk-actions-in-pane decision); accordion keeps them at the top of the list.
  const emptyTrashInPane = showEmptyTrashButton && layoutMode === "master-detail";

  // ── INV-S5: selection mode pane shows summary + no decrypt ──────────────────

  const detailSlot = layoutMode === "master-detail" && selectionMode ? (
    // In master-detail, the detail pane is idle during selection — host the bulk
    // action buttons here (the list's FloatingActionBar is suppressed below) so they
    // are prominent and don't crowd the narrow list.
    <div className="flex flex-col items-center justify-center h-full py-16 text-center text-muted-foreground gap-4">
      <p className="text-sm">{t("selectedInPane", { count: selectedIds.size })}</p>
      {/* Buttons always shown; disabled until 1+ selected. */}
      <div className="flex flex-wrap items-center justify-center gap-2">{floatingActions}</div>
    </div>
  ) : emptyTrashInPane && !activeEntry ? (
    // Trash, nothing selected: explain trash retention and host the destructive
    // empty-trash action in the wide pane (decluttered from the list).
    <div className="flex flex-col items-center justify-center h-full py-16 text-center gap-4 px-6">
      <Trash2 className="h-10 w-10 text-muted-foreground/40" />
      <p className="max-w-md text-sm text-muted-foreground">{tTrash("description")}</p>
      <Button variant="destructive" size="sm" onClick={() => setEmptyTrashConfirmOpen(true)}>
        {tTrash("emptyTrash")}
      </Button>
    </div>
  ) : (
    <PasswordDetailPane
      key={activeEntry?.id ?? "none"}
      entryId={activeEntry?.id ?? null}
      entry={activeEntry}
      detailData={detailData}
      loading={detailLoading}
      error={detailError}
      onEdit={
        activeEntry && descriptor.rowActions.edit && adapter.permissions.canEdit
          ? () => onRequestEdit?.(activeEntry)
          : undefined
      }
      onRefresh={() => {
        invalidateDetail();
        onDataChange?.();
      }}
      teamId={adapter.teamId}
      readOnly={descriptor.detailReadOnly || !adapter.permissions.canEdit}
    />
  );

  const confirmDialog = {
    open: bulkDialogOpen,
    onOpenChange: setBulkDialogOpen,
    title:
      pendingAction === "archive"
        ? t("moveSelectedToArchive")
        : pendingAction === "unarchive"
          ? t("moveSelectedToUnarchive")
          : pendingAction === "restore"
            ? tTrash("restoreSelected")
            : pendingAction === "deletePermanently"
              ? tTrash("deleteSelectedPermanently")
              : t("moveSelectedToTrash"),
    description:
      pendingAction === "archive"
        ? t("bulkArchiveConfirm", { count: selectedIds.size })
        : pendingAction === "unarchive"
          ? t("bulkUnarchiveConfirm", { count: selectedIds.size })
          : pendingAction === "restore"
            ? tTrash("bulkRestoreConfirm", { count: selectedIds.size })
            : pendingAction === "deletePermanently"
              ? tTrash("bulkDeleteConfirm", { count: selectedIds.size })
              : t("bulkMoveConfirm", { count: selectedIds.size }),
    cancelLabel: t("cancel"),
    confirmLabel: t("confirm"),
    processing: bulkProcessing,
    onConfirm: () => void executeAction(),
  };

  // ── Row render ──────────────────────────────────────────────────────────────

  const listSlot = (
    <div
      ref={listPaneRef}
      tabIndex={layoutMode === "master-detail" ? 0 : undefined}
      onKeyDown={handleListKeyDown}
      className="outline-none h-full space-y-4 p-2"
    >
      {/* Accordion only: master-detail hosts this in the detail pane (emptyTrashInPane). */}
      {showEmptyTrashButton && !emptyTrashInPane && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{tTrash("description")}</p>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setEmptyTrashConfirmOpen(true)}
          >
            {tTrash("emptyTrash")}
          </Button>
        </div>
      )}
      <EntryListShell
        entries={entries}
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        atLimit={atLimit}
        onToggleSelectOne={toggleSelectOne}
        selectEntryLabel={(title) => t("selectEntry", { title })}
        hideFloatingBar={layoutMode === "master-detail"}
        renderEntry={(entry) => {
          if (layoutMode === "master-detail") {
            // INV-S1/S4: LAZY — buildRowCallbacks(entry) creates closures but
            // does NOT invoke buildGetDetail()() here. Invocation only occurs on
            // explicit user copy/reveal events inside useEntryActions.
            const callbacks = buildRowCallbacks(entry);
            return (
              <PasswordRow
                entry={entry}
                isActive={activeEntry?.id === entry.id}
                onActivate={() => {
                  if (activeEntry?.id === entry.id) {
                    setActiveEntry(null);
                  } else {
                    setActiveEntry(entry);
                  }
                }}
                selectionMode={selectionMode}
                showFavorite={descriptor.rowActions.favorite && adapter.supportsFavorite}
                onToggleFavorite={() => void handleSetFavorite(entry, !entry.isFavorite)}
                {...callbacks}
                onShare={() => {
                  setActiveEntry(entry);
                  onRequestShare?.(entry);
                }}
                onEdit={() => {
                  setActiveEntry(entry);
                  onRequestEdit?.(entry);
                }}
                onToggleArchive={() => {
                  void handleSetArchived(entry, !entry.isArchived);
                }}
                onDeleteRequest={() => void handleSoftDelete(entry)}
                canEdit={descriptor.rowActions.edit && adapter.permissions.canEdit}
                canDelete={descriptor.rowActions.trash && adapter.permissions.canDelete}
                canShare={descriptor.rowActions.share && adapter.permissions.canShare}
                // C9 — trash affordances (INV-C9.1: gated by descriptor + canDelete).
                onRestore={
                  descriptor.rowActions.restore && adapter.permissions.canDelete
                    ? () => void handleRestore(entry)
                    : undefined
                }
                onDeletePermanently={
                  descriptor.rowActions.deletePermanently && adapter.permissions.canDelete
                    ? () => setDeletePermanentlyPending(entry)
                    : undefined
                }
              />
            );
          }
          // Team accordion: PasswordCard's "team mode" (isTeamMode = !!getPassword)
          // requires the team-aware fetchers so reveal/copy/expand decrypt against the
          // TEAM vault, not the personal one. Personal omits them (self-fetches the
          // personal endpoint). Derived from adapter.buildGetDetail (lazy, on demand).
          const teamCardProps =
            adapter.kind === "team"
              ? {
                  getDetail: () => adapter.buildGetDetail(entry)(),
                  getPassword: async () => {
                    const d = await adapter.buildGetDetail(entry)();
                    return d.password || d.content || "";
                  },
                  getUrl: async () => (await adapter.buildGetDetail(entry)()).url,
                  createdBy: adapter.createdByLabel?.(entry),
                }
              : {};
          return (
            <PasswordCard
              entry={entry as unknown as EntryCardData}
              expanded={activeEntry?.id === entry.id && layoutMode === "accordion"}
              onToggleFavorite={handleCardToggleFavorite}
              onToggleArchive={handleCardToggleArchive}
              onDelete={handleCardDelete}
              onToggleExpand={handleToggleExpand}
              onRefresh={() => { invalidateDetail(); onDataChange?.(); }}
              canEdit={descriptor.rowActions.edit && adapter.permissions.canEdit}
              canDelete={descriptor.rowActions.trash && adapter.permissions.canDelete}
              canShare={descriptor.rowActions.share && adapter.permissions.canShare}
              readOnly={descriptor.detailReadOnly}
              teamId={adapter.teamId}
              {...teamCardProps}
            />
          );
        }}
        floatingActions={floatingActions}
        confirmDialog={confirmDialog}
      />
    </div>
  );

  return (
    <>
      <MasterDetailShell
        layoutMode={layoutMode}
        activeEntryId={activeEntry?.id ?? null}
        listSlot={listSlot}
        detailSlot={detailSlot}
      />
      {/* C9 — delete-permanently confirm dialog (INV-C9.2). */}
      <Dialog
        open={!!deletePermanentlyPending}
        onOpenChange={(open) => {
          if (!open) setDeletePermanentlyPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tTrash("deletePermanently")}</DialogTitle>
            <DialogDescription>
              {tTrash("deleteConfirm", { title: deletePermanentlyPending?.title ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" onClick={() => void handleDeletePermanentlyConfirmed()}>
              {tTrash("deletePermanently")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Empty-trash confirm dialog (gated by descriptor.showEmptyTrashButton + canDelete). */}
      <Dialog open={emptyTrashConfirmOpen} onOpenChange={setEmptyTrashConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tTrash("emptyTrash")}</DialogTitle>
            <DialogDescription>{tTrash("emptyTrashConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={isEmptyingTrash}
              onClick={() => void handleEmptyTrashConfirmed()}
            >
              {isEmptyingTrash && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {tTrash("emptyTrash")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
