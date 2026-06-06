/**
 * C1 — VaultListAdapter interface
 *
 * Injects everything vault-specific into the shared EntryListView:
 * list fetch + overview decrypt, buildGetDetail, mutations, permissions,
 * and availability (locked / key-pending).
 *
 * File: types only — no React import.
 */

import type { PasswordRowEntry } from "@/components/passwords/detail/password-row";
import type { PasswordDetailPaneEntry } from "@/components/passwords/detail/password-detail-pane";
import type { InlineDetailData } from "@/types/entry";
import type { BulkScope } from "@/hooks/bulk/use-bulk-action";

// ---------------------------------------------------------------------------
// EntryListViewKind — the seven view variants the shared component supports.
// ---------------------------------------------------------------------------

export type EntryListViewKind =
  | "normal"
  | "favorites"
  | "category"
  | "folder"
  | "tag"
  | "archive"
  | "trash";

// ---------------------------------------------------------------------------
// EntryListQuery — extra filter parameters for a view (tag / folder / type).
// Normal views omit all; trash/archive pass their own apiQuery flags separately
// via the ListViewDescriptor.
// ---------------------------------------------------------------------------

export interface EntryListQuery {
  tagId?: string | null;
  folderId?: string | null;
  entryType?: string | null;
}

// ---------------------------------------------------------------------------
// EntryListAvailability — whether the adapter's vault is ready to fetch/decrypt.
// When ready === false, EntryListView renders a gate card and skips fetching
// (INV-C4.3). The reason drives which gate card variant to show.
// ---------------------------------------------------------------------------

export interface EntryListAvailability {
  /** true → render list; false → render gate card */
  ready: boolean;
  reason?: "locked" | "key-pending";
}

// ---------------------------------------------------------------------------
// AdapterUnsupportedError — thrown by mutation methods that the current vault
// does not support (INV-C1.3). Machine-readable: callers read
// adapter.supportsFavorite / adapter.permissions to avoid calling throwing
// methods (INV-DEV1); this class is the safety net for misconfigured
// descriptor × adapter combinations caught at runtime.
// ---------------------------------------------------------------------------

export class AdapterUnsupportedError extends Error {
  constructor(message = "Operation not supported by this vault adapter") {
    super(message);
    this.name = "AdapterUnsupportedError";
  }
}

// ---------------------------------------------------------------------------
// VaultListAdapter<E> — the primary seam between vault-specific data layers
// and the vault-agnostic EntryListView shared component (C3).
//
// Generic E extends both PasswordRowEntry (row rendering) and
// PasswordDetailPaneEntry (pane header rendering), so the concrete adapter
// entry type flows through opaquely — team-only fields like `createdBy` ride
// along without requiring EntryListView to know about them (INV-C6.1).
// ---------------------------------------------------------------------------

export interface VaultListAdapter<E extends PasswordRowEntry & PasswordDetailPaneEntry> {
  /** "personal" | "team" — used by EntryListView for vault-specific decisions. */
  kind: "personal" | "team";

  /** Present iff kind === "team". Passed to PasswordDetailPane as teamId. */
  teamId?: string;

  /** Vault readiness. EntryListView gates fetch + pane decrypt on this. */
  availability: EntryListAvailability;

  /**
   * Capability flags for the mounting vault + user role.
   * EntryListView intersects these with descriptor.rowActions to decide which
   * affordances render (INV-S6). Personal vault: all true. Team: derived from
   * OWNER/ADMIN/MEMBER/VIEWER role per C6.
   */
  permissions: {
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canShare: boolean;
  };

  /**
   * Whether this vault supports the favorite toggle (F7).
   * personal = true, team = false. EntryListView reads this flag for INV-DEV1
   * checks rather than calling setFavorite() to discover support.
   */
  supportsFavorite: boolean;

  /**
   * Fetch raw rows for a view and decrypt their OVERVIEW blobs into E.
   * Honors AbortSignal. Preserves per-vault decrypt-failure policy
   * (personal: skip; team: placeholder — INV-C1.1, C5.2, C6.2).
   * For view === "trash", decrypts the FULL overview shape incl. tags
   * and all per-type fields (INV-C1.4/C1.5/F2).
   */
  fetchOverviewEntries(
    view: EntryListViewKind,
    query: EntryListQuery,
    signal: AbortSignal,
  ): Promise<E[]>;

  /**
   * Returns a closure that resolves the full InlineDetailData for a given entry.
   * The closure is supplied to useEntryActions + usePasswordEntryDetail; it is
   * invoked ONLY on explicit user events (copy/reveal) or pane activation —
   * never per-row at render (INV-S1/S4). Funnels through the existing
   * buildPersonalGetDetail / buildTeamGetDetail helpers (INV-C1.2).
   */
  buildGetDetail(entry: E): () => Promise<InlineDetailData>;

  // -------------------------------------------------------------------------
  // Single-entry mutations (INV-C1.4 — network-only; view owns
  // optimistic removal, rollback, and notify*DataChanged on success).
  // Each rejects on non-2xx; never silently swallows (INV-F4).
  // -------------------------------------------------------------------------

  /** Toggle favorite. Personal only; team throws AdapterUnsupportedError (INV-C1.3). */
  setFavorite(entry: E, next: boolean): Promise<void>;

  /** Archive (next=true) or unarchive (next=false) the entry. */
  setArchived(entry: E, next: boolean): Promise<void>;

  /** Move entry to trash (soft delete). */
  softDelete(entry: E): Promise<void>;

  /** Restore entry from trash or archive to active. */
  restore(entry: E): Promise<void>;

  /** Permanently delete entry (no recovery). */
  deletePermanently(entry: E): Promise<void>;

  /** Empty the entire trash for this vault. */
  emptyTrash(): Promise<void>;

  /**
   * Fire the vault's data-changed event after a successful mutation so sidebar
   * live-counts stay in sync (INV-C1.4). Personal → notifyVaultDataChanged;
   * team → notifyTeamDataChanged. EntryListView calls this instead of hardcoding
   * a personal-only event, keeping the view vault-agnostic.
   */
  notifyDataChanged(): void;

  /**
   * Returns the BulkScope object consumed by useBulkAction (existing hook).
   * Personal → { type: "personal" }. Team → { type: "team", teamId }.
   * The view argument allows future view-specific scoping if needed.
   */
  bulkScope(view: EntryListViewKind): BulkScope;
}
