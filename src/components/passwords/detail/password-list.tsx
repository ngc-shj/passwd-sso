"use client";

/**
 * PasswordList — thin wrapper over EntryListView for the personal vault
 * normal/favorites/archive views (Batch 2, C7).
 *
 * Preserves its public prop surface so PasswordDashboard's usage is unchanged.
 * All orchestration (fetch/decrypt/sort/search/selection/master-detail) now
 * lives in EntryListView + useEntryListData + PersonalVaultListAdapter.
 */

import type { EntrySortOption } from "@/lib/vault/entry-sort";
import type { BulkSelectionHandle } from "@/hooks/bulk/use-bulk-selection";
import { EntryListView, type EntryListHandle } from "@/components/passwords/detail/entry-list-view";
import { usePersonalVaultListAdapter } from "@/lib/vault/personal-vault-list-adapter";
import {
  NORMAL_VIEW,
  FAVORITES_VIEW,
  ARCHIVE_VIEW,
  TRASH_VIEW,
} from "@/components/passwords/detail/entry-list-view-descriptors";

// ---------------------------------------------------------------------------
// DisplayEntry — re-exported from the shared types location so consumers that
// import from password-list continue to work without changes.
// ---------------------------------------------------------------------------

export type { DisplayEntry } from "@/types/display-entry";

export type SortOption = EntrySortOption;

// Re-exported for backward compatibility (PasswordDashboard uses PasswordListHandle).
export type PasswordListHandle = BulkSelectionHandle & EntryListHandle;

// ---------------------------------------------------------------------------
// PasswordListProps — original prop surface preserved for PasswordDashboard.
// ---------------------------------------------------------------------------

interface PasswordListProps {
  searchQuery: string;
  tagId: string | null;
  folderId?: string | null;
  entryType?: string | null;
  refreshKey: number;
  favoritesOnly?: boolean;
  archivedOnly?: boolean;
  /** C7: select TRASH_VIEW (personal trash 3-pane) */
  trashOnly?: boolean;
  sortBy?: SortOption;
  onDataChange?: () => void;
  onSelectedCountChange?: (count: number, allSelected: boolean, atLimit: boolean) => void;
  selectAllRef?: React.Ref<PasswordListHandle>;
  // Active-entry, selection mode, master-detail layout, and keyboard nav are all
  // owned inside EntryListView now — the container no longer threads them through.
  onEntryRemoved?: (id: string) => void;
  // Edit/share are container-hosted dialogs; EntryListView raises these requests.
  onRequestEdit?: (entry: import("@/types/display-entry").DisplayEntry) => void;
  onRequestShare?: (entry: import("@/types/display-entry").DisplayEntry) => void;
}

// ---------------------------------------------------------------------------
// PasswordList — thin wrapper
// ---------------------------------------------------------------------------

export function PasswordList({
  searchQuery,
  tagId,
  folderId,
  entryType,
  refreshKey,
  favoritesOnly = false,
  archivedOnly = false,
  trashOnly = false,
  sortBy = "updatedAt",
  onDataChange,
  onSelectedCountChange,
  selectAllRef,
  onEntryRemoved,
  onRequestEdit,
  onRequestShare,
}: PasswordListProps) {
  const adapter = usePersonalVaultListAdapter();

  const descriptor = trashOnly
    ? TRASH_VIEW
    : archivedOnly
      ? ARCHIVE_VIEW
      : favoritesOnly
        ? FAVORITES_VIEW
        : NORMAL_VIEW;

  return (
    <EntryListView
      adapter={adapter}
      descriptor={descriptor}
      query={{ tagId, folderId, entryType }}
      searchQuery={searchQuery}
      sortBy={sortBy}
      refreshKey={refreshKey}
      onSelectedCountChange={onSelectedCountChange}
      listRef={selectAllRef as React.Ref<EntryListHandle>}
      onDataChange={onDataChange}
      onRequestEdit={onRequestEdit}
      onRequestShare={onRequestShare}
      onEntryRemoved={onEntryRemoved}
    />
  );
}
