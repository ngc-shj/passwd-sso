/**
 * C2 — ListViewDescriptor and the four canonical view constants.
 *
 * A descriptor is a pure-data object that injects all view-specific policy
 * into EntryListView: which API query flags to use, which row/bulk actions
 * render, sort order, and i18n empty-state key.
 *
 * Descriptors are vault-agnostic — adapter.permissions × descriptor.rowActions
 * is the intersection that determines what actually renders (INV-S6/INV-C2.1).
 */

import type { EntryListViewKind } from "@/lib/vault/vault-list-adapter";

// ---------------------------------------------------------------------------
// EntryBulkActionKind — the four bulk operation verbs supported across views.
// The full BulkActionType from use-bulk-action.ts is identical; this alias
// lives here so descriptor files have no dependency on the hook module.
// ---------------------------------------------------------------------------

export type EntryBulkActionKind = "archive" | "unarchive" | "trash" | "restore";

// ---------------------------------------------------------------------------
// ListViewDescriptor — per-view policy consumed by EntryListView (C3).
// ---------------------------------------------------------------------------

export interface ListViewDescriptor {
  /** Which view variant this descriptor represents. */
  kind: EntryListViewKind;

  /**
   * API query flags appended to the fetch URL.
   * Normal views omit both. Archive passes { archived: true }.
   * Trash passes { trash: true }. Mapped to ?archived / ?trash query params.
   */
  apiQuery: { archived?: boolean; trash?: boolean };

  /**
   * Which per-row affordances render in the entry row / actions menu.
   * EntryListView intersects these with adapter.permissions (INV-S6/INV-C2.1).
   */
  rowActions: {
    edit: boolean;
    share: boolean;
    favorite: boolean;
    archive: boolean;
    trash: boolean;
    restore: boolean;
    deletePermanently: boolean;
  };

  /**
   * Which bulk action buttons render in the bulk action bar.
   * A subset of EntryBulkActionKind. EntryListView passes these to useBulkAction.
   */
  bulkActions: EntryBulkActionKind[];

  /**
   * Whether the "Empty Trash" button renders.
   * True only for TRASH_VIEW. Additionally gated by adapter.permissions.canDelete
   * (team OWNER/ADMIN; personal unconditional — F4).
   */
  showEmptyTrashButton: boolean;

  /**
   * Whether the detail pane is read-only.
   * TRASH only → true (INV-C2.2 / F3 / S6). Archive is editable (F3).
   * Also intersected with !adapter.permissions.canEdit in practice.
   */
  detailReadOnly: boolean;

  /**
   * Favorites view only (F8): unfavoriting a row optimistically removes it
   * from the list, because the entry no longer belongs in this view.
   */
  removeOnUnfavorite: boolean;

  /**
   * Client-side sort strategy applied post-decrypt (INV-C4.2).
   * "favoriteThenUpdated" → compareEntriesWithFavorite (normal/archive/favorites).
   * "deletedAt" → compareEntriesByDeletedAt (trash).
   */
  sort: "favoriteThenUpdated" | "deletedAt";

  /**
   * i18n key (PasswordList namespace) for the empty-list message.
   * Consumed as t(descriptor.emptyStateKey) inside EntryListView.
   * Keys must exist in messages/en/PasswordList.json (verified below).
   */
  emptyStateKey: string;
}

// ---------------------------------------------------------------------------
// NORMAL_VIEW — base descriptor for normal / category / folder / tag views.
// Category/folder/tag views share this descriptor but pass a non-empty
// EntryListQuery (tagId / folderId / entryType) to narrow the fetch.
// ---------------------------------------------------------------------------

// emptyStateKey: "noPasswords" exists in messages/en/PasswordList.json
export const NORMAL_VIEW: ListViewDescriptor = {
  kind: "normal",
  apiQuery: {},
  rowActions: {
    edit: true,
    share: true,
    favorite: true,
    archive: true,
    trash: true,
    restore: false,
    deletePermanently: false,
  },
  bulkActions: ["archive", "trash"],
  showEmptyTrashButton: false,
  detailReadOnly: false,
  removeOnUnfavorite: false,
  sort: "favoriteThenUpdated",
  emptyStateKey: "noPasswords",
};

// ---------------------------------------------------------------------------
// FAVORITES_VIEW — NORMAL_VIEW + removeOnUnfavorite=true (F8 / INV-C2.1).
// Unfavoriting removes the row from this view because it no longer qualifies.
// emptyStateKey: "noFavorites" exists in messages/en/PasswordList.json
// ---------------------------------------------------------------------------

export const FAVORITES_VIEW: ListViewDescriptor = {
  ...NORMAL_VIEW,
  kind: "favorites",
  removeOnUnfavorite: true,
  emptyStateKey: "noFavorites",
};

// ---------------------------------------------------------------------------
// ARCHIVE_VIEW — detailReadOnly=false (INV-C2.2 / F3: archive is editable).
// Bulk: unarchive + trash (removing from archive or discarding).
// rowActions: archive=false (already archived), trash=true (discard), restore=false
// (restore is trash-specific), unarchive via setArchived(entry, false) from
// the archive toggle (existing onToggleArchive contract).
// emptyStateKey: "noArchive" exists in messages/en/PasswordList.json
// ---------------------------------------------------------------------------

export const ARCHIVE_VIEW: ListViewDescriptor = {
  kind: "archive",
  apiQuery: { archived: true },
  rowActions: {
    edit: true,
    share: true,
    favorite: true,   // runtime-gated by adapter.supportsFavorite (INV-C2.1/INV-DEV1)
    archive: true,    // toggling archive→unarchive via setArchived(entry, false)
    trash: true,
    restore: false,   // restore is trash-specific
    deletePermanently: false,
  },
  bulkActions: ["unarchive", "trash"],
  showEmptyTrashButton: false,
  detailReadOnly: false,   // INV-C2.2: archive is editable (F3)
  removeOnUnfavorite: false,
  sort: "favoriteThenUpdated",
  emptyStateKey: "noArchive",
};

// ---------------------------------------------------------------------------
// TRASH_VIEW — read-only browse; restore + delete-permanently affordances;
// empty-trash button; sorts by deletedAt desc (INV-C2.2 / S6 / F4).
// emptyStateKey: "noTrash" exists in messages/en/PasswordList.json
// ---------------------------------------------------------------------------

export const TRASH_VIEW: ListViewDescriptor = {
  kind: "trash",
  apiQuery: { trash: true },
  rowActions: {
    edit: false,
    share: false,
    favorite: false,
    archive: false,
    trash: false,
    restore: true,
    deletePermanently: true,
  },
  bulkActions: ["restore"],
  showEmptyTrashButton: true,
  detailReadOnly: true,   // INV-C2.2: trash is read-only for ALL roles incl. OWNER (S6)
  removeOnUnfavorite: false,
  sort: "deletedAt",
  emptyStateKey: "noTrash",
};
