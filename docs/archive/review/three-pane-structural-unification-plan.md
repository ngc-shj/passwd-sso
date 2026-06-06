# Plan: three-pane-structural-unification

## Project context

- **Type**: web app (Next.js 16 App Router, React, TypeScript). Security-critical: client-side E2E-encrypted password manager.
- **Test infrastructure**: unit + integration (Vitest) + CI/CD (GitHub Actions) + Playwright E2E. Mandatory gates per CLAUDE.md: `npx vitest run` and `npx next build`; pre-PR via `scripts/pre-pr.sh`.
- **Verification environment constraints**:
  - **VC1 — responsive layout (`master-detail` vs `accordion`) is matchMedia-driven and not exercisable in jsdom.** `useLayoutMode` SSR-safe matchMedia branching must be verified in a real browser (`verifiable-local`, manual). Unit tests can force a mode by mocking `useLayoutMode`.
  - **VC2 — clear-on-lock via VaultGate unmount is a React lifecycle behavior.** Verifiable via unit test (assert children unmount when status≠UNLOCKED) AND in-browser (`verifiable-local`). The bfcache `pageshow` lock path requires a real browser back/forward (`verifiable-local`, manual; not reproducible in jsdom).
  - **VC3 — team shared-key decryption (`getEntryDecryptionKey`, ItemKey unwrap) requires a seeded team with distributed member keys.** Overview/detail decrypt parity is `verifiable-local` against a dev DB with a real team; not reproducible from mocked unit tests alone (mocks return fixed plaintext — see [[project_integration_test_gap]]).
  - **VC4 — `keyPending` state (member key not yet distributed) requires a freshly-invited team member whose key confirmation is pending.** `verifiable-local` against dev DB; the gate-card render path is unit-testable by forcing the adapter's `unavailableReason`.

This is a **refactor with NO new user-facing feature and NO new API endpoint** — it collapses 5 parallel list implementations into one shared, vault-agnostic component. Reviewers MUST NOT raise Major/Critical findings recommending net-new test frameworks; the project already has full coverage. Findings about *preserving* existing behavior/coverage are in scope.

## Objective

Eliminate the structural duplication identified in PR #515's deviation log (`D8`, `TODO(three-pane-structural-unification)`): personal and team vaults render their entry lists through **five separate implementations** that each independently fetch, decrypt overviews, sort/search, manage selection, wire the master-detail shell, and host dialogs. Unify them behind **one vault-agnostic list component** driven by an injected **data-layer adapter** + a **view descriptor**, so that:

1. Normal / favorites / category / folder / tag / **archive** / **trash** views all render through the same component in both vaults.
2. **Trash becomes 3-pane** in both vaults (task 2), replacing the two bespoke flat `TrashList` / `TeamTrashList` components. NOTE (revised after review F1): this is NOT free — the shared `PasswordRow`/`EntryActionsMenu` today have no restore/delete-permanently affordance, so trash 3-pane requires net-new shared destructive-row UI (contract C9). It is unification-enabling, not incidental.
3. Future views (e.g. emergency-access vault browse) wire in by supplying an adapter, not by building a parallel list.

This directly realizes [[feedback_commonize_personal_team_ui_logic]]: build the shared shell so team wires in, not a parallel build.

## Requirements

### Functional
- F-R1: Visual + behavioral parity with current state for every existing personal view (normal/favorites/category/folder/tag/archive) — no regression. Personal is the reference behavior.
- F-R2: Visual + behavioral parity for every existing team view (normal/archive). Team trash gains 3-pane (new) but keeps all existing actions (restore / delete-permanently / empty-trash).
- F-R3: Personal trash gains 3-pane (new) but keeps all existing actions.
- F-R4: All bulk operations (archive/unarchive/trash/restore/empty-trash/select-all/limit) preserved per view, per vault.
- F-R5: Role gating preserved for team (`canEdit`/`canDelete`/`canShare`/`canCreate` by OWNER/ADMIN/MEMBER/VIEWER). Personal has no role gating (owner-only).
- F-R6: `keyPending` gate preserved for team (warning card when member key undistributed); never shown for personal.

### Non-functional
- NF-R1: All security invariants below (INV-S*) preserved — this is the hard constraint, not parity.
- NF-R2: Net reduction in component LOC (duplication removed). The 5 list impls collapse toward 1 shared component + 2 thin adapters + per-view descriptors.
- NF-R3: Existing unit/integration tests for the personal path continue to pass with minimal churn; the adapter wraps the same primitives the tests already exercise.

## Technical approach

### Chosen architecture (recommended — D-fork resolved in favor of "extract shared component + adapter")

Two candidates were considered; the plan locks **Candidate B**.

- **Candidate A — generalize `PasswordList` in place.** Thread a `VaultListAdapter` through the existing `PasswordList`, keeping it as the single shared component. *Pro*: maximal reuse of the most-tested component, least new surface. *Con*: `PasswordList` today reaches `useVault()` directly and hard-codes `DisplayEntry` + `/api/passwords`; in-place generalization threads adapter props through ~490 lines of security-sensitive code and risks regressing the personal path the prior PR just stabilized (D2/D3).
- **Candidate B — extract a shared `EntryListView` presentational component + a `useEntryListData` data hook, both driven by a `VaultListAdapter` and a `ListViewDescriptor`.** `PasswordList` becomes a thin personal wrapper: `<EntryListView adapter={personalAdapter} view={descriptor} … />`. Team page, `TeamArchivedList`, `TeamTrashList`, and personal `TrashList` all become thin wrappers over the same `EntryListView`. *Pro*: one place owns the master-detail/selection/dialog orchestration; per-vault code shrinks to an adapter; the personal path's existing behavior is reproduced by `PersonalVaultListAdapter` so its tests largely transfer. *Con*: more upfront extraction.

**Rationale for B**: the duplication is in *orchestration* (fetch→decrypt-overview→sort/search→select→activate→pane→dialogs→mutations), not in rendering (already shared via `PasswordRow`/`PasswordDetailPane`). Extracting orchestration into one component+hook is the structural fix; an adapter is the injection seam already prefigured by `useEntryActions(getDetailFor)`, `buildPersonalGetDetail`, `buildTeamGetDetail`. B keeps the security-critical pane wiring (`key={entryId}`, `usePasswordEntryDetail`, VaultGate residency) in exactly ONE place, which is strictly better for auditing INV-S*.

### The three new seams

1. **`VaultListAdapter<E>`** (C1) — injects everything vault-specific: list fetch + overview decrypt, `buildGetDetail`, mutations, permissions, availability (`vaultLocked` / `keyPending`). Personal and team each provide one.
2. **`ListViewDescriptor`** (C2) — injects everything view-specific: which API query, which row/bulk actions, detail read-only-ness, sort comparator, empty-state copy. Normal/archive/trash are descriptors, not components.
3. **`EntryListView`** (C3) + **`useEntryListData`** (C4) — the shared orchestration consuming (adapter, descriptor).

### What is explicitly REUSED (no new equivalents — INV-reuse)
`MasterDetailShell`, `PasswordRow`/`PasswordRowEntry`, `PasswordDetailPane`/`PasswordDetailPaneEntry`, `PasswordCard` (accordion), `EntryIcon`, `EntrySecondaryLine`, `EntryActionsMenu`, `useLayoutMode`, `usePasswordEntryDetail`, `useEntryActions`, `useBulkSelection`, `useBulkAction`, `mapDecryptedBlobToDetailFields`, `buildPersonalGetDetail`, `buildTeamGetDetail`, `VaultGate`. New code that re-implements any of these is a finding (R1).

## Contracts

> IDs are stable. Consumer-flow walkthroughs are mandatory for shape-defining contracts (C1, C2, C5, C6) and appear in the Acceptance section.

### C1 — `VaultListAdapter<E>` interface
- **File**: `src/lib/vault/vault-list-adapter.ts` (new, types only — no React).
- **Signature**:
  ```ts
  export type EntryListViewKind =
    | "normal" | "favorites" | "category" | "folder" | "tag" | "archive" | "trash";

  export interface EntryListAvailability {
    ready: boolean;                 // true → render list; false → render gate card
    reason?: "locked" | "key-pending";
  }

  export interface VaultListAdapter<E extends PasswordRowEntry & PasswordDetailPaneEntry> {
    kind: "personal" | "team";
    teamId?: string;                // present iff kind==="team" (passed to PasswordDetailPane)
    availability: EntryListAvailability;
    permissions: { canCreate: boolean; canEdit: boolean; canDelete: boolean; canShare: boolean };
    supportsFavorite: boolean;      // capability flag (F7): personal=true, team=false. Drives INV-DEV1 without calling throwing methods.

    // Fetch raw rows for a view and decrypt their OVERVIEW blobs into E (FULL overview shape,
    // incl. trash — see INV-C1.4). Honors AbortSignal. Preserves per-vault decrypt-failure policy (INV-C5.2/C6.2).
    fetchOverviewEntries(view: EntryListViewKind, query: EntryListQuery, signal: AbortSignal): Promise<E[]>;

    // Detail closure feeding BOTH useEntryActions row callbacks AND the pane (via usePasswordEntryDetail).
    buildGetDetail(entry: E): () => Promise<InlineDetailData>;

    // Single-entry mutations. Each rejects on non-2xx; never silently swallows (INV-F4).
    setFavorite(entry: E, next: boolean): Promise<void>;     // personal only; team: throws NotSupported
    setArchived(entry: E, next: boolean): Promise<void>;     // archive ↔ unarchive
    softDelete(entry: E): Promise<void>;                     // → trash
    restore(entry: E): Promise<void>;                        // trash/archive → active
    deletePermanently(entry: E): Promise<void>;
    emptyTrash(): Promise<void>;

    // Bulk scope object consumed by useBulkAction (existing hook).
    bulkScope(view: EntryListViewKind): BulkActionScope;
  }
  ```
  where `EntryListQuery = { tagId?: string|null; folderId?: string|null; entryType?: string|null }`.
- **Invariants**:
  - INV-C1.1 (app-enforced): `fetchOverviewEntries` returns entries already decrypted to `E`; the caller never sees ciphertext. Decryption (personal AAD vs team AAD+ItemKey) lives entirely inside the adapter.
  - INV-C1.2 (app-enforced): `buildGetDetail(entry)()` resolves exactly the `InlineDetailData` for `entry.id` via the existing `buildPersonalGetDetail`/`buildTeamGetDetail` (no new decrypt site — funnels through `mapDecryptedBlobToDetailFields`, R1).
  - INV-C1.3 (app-enforced): a mutation method that the current vault/view does not support (e.g. `setFavorite` on team) throws a typed `AdapterUnsupportedError` rather than no-op'ing, so the descriptor never wires an action the adapter can't honor. The machine-readable form is `supportsFavorite` (INV-DEV1 reads the flag, never calls the throwing method — F7).
  - INV-C1.4 (app-enforced — mutation side-effect contract, F5): each mutation method performs ONLY the network call and resolves on 2xx / rejects on non-2xx; it never mutates the view's list. The VIEW (`EntryListView`) owns: (a) optimistic removal from `useEntryListData`'s list before the call, (b) rollback-via-reload on rejection, and (c) firing the vault/team data-changed event (`notifyVaultDataChanged` / `notifyTeamDataChanged`) AFTER a successful mutation — this keeps the sidebar live-counts in sync and must not be dropped (today: `useTeamEntryMutations` always notifies; personal via `onDataChange`). Reuse the existing `useTeamEntryMutations` for the team path rather than re-implementing optimistic+notify (R1).
  - INV-C1.5 (app-enforced — trash widening, F2): for `view === "trash"`, `fetchOverviewEntries` decrypts the FULL `PasswordRowEntry`+`PasswordDetailPaneEntry` overview shape (all per-type fields + tags), not today's minimal subset. This is an intentional change: trash rows render the rich `EntrySecondaryLine` and the master-detail pane needs `tags`. Residency note (security): the additional resident fields are non-secret summary data already decrypted for non-trash views.
- **Why app-enforced not schema-enforced**: this is a TypeScript interface boundary, not a storage constraint; there is no DB column to express it. The runtime guard (INV-C1.3 throw) is the strongest available form.
- **Forbidden patterns**:
  - `pattern: useVault\(\)` inside `src/components/passwords/detail/entry-list-view.tsx` — reason: the shared view must be vault-agnostic; vault access only through the adapter.
  - `pattern: /api/passwords` (literal) inside `entry-list-view.tsx` / `useEntryListData` — reason: API paths belong to adapters.
  - `pattern: getEntryDecryptionKey` inside `entry-list-view.tsx` — reason: team decryption belongs to the team adapter only.

### C2 — `ListViewDescriptor`
- **File**: `src/components/passwords/detail/entry-list-view-descriptors.ts` (new).
- **Signature**:
  ```ts
  export interface ListViewDescriptor {
    kind: EntryListViewKind;
    apiQuery: { archived?: boolean; trash?: boolean };   // maps to ?archived / ?trash; normal omits both
    rowActions: {                                          // which per-row affordances render
      edit: boolean; share: boolean; favorite: boolean;
      archive: boolean; trash: boolean; restore: boolean; deletePermanently: boolean;
    };
    bulkActions: BulkActionKind[];                         // subset of: archive|unarchive|trash|restore
    showEmptyTrashButton: boolean;                         // trash only
    detailReadOnly: boolean;                               // TRASH only → true (F3: archive stays editable)
    removeOnUnfavorite: boolean;                           // favorites view only (F8): unfavorite removes the row
    sort: "favoriteThenUpdated" | "deletedAt";             // trash sorts by deletedAt desc
    emptyStateKey: string;                                 // i18n key for the empty list message
  }
  export const NORMAL_VIEW: ListViewDescriptor;     // base for category/folder/tag (differ only by EntryListQuery)
  export const FAVORITES_VIEW: ListViewDescriptor;  // NORMAL_VIEW + removeOnUnfavorite=true (F8)
  export const ARCHIVE_VIEW: ListViewDescriptor;    // detailReadOnly=false; bulk unarchive/trash
  export const TRASH_VIEW: ListViewDescriptor;      // detailReadOnly=true; restore/deletePermanently; showEmptyTrashButton
  ```
- **Invariants**:
  - INV-C2.1: a descriptor never enables a `rowAction`/`bulkAction` the adapter does not support for the mounting vault. Cross-checked at mount via INV-DEV1, which reads `adapter.supportsFavorite` / `adapter.permissions` (NOT by calling throwing methods — F7).
  - INV-C2.2 (corrected per F3): `TRASH_VIEW.detailReadOnly === true` ONLY. `ARCHIVE_VIEW.detailReadOnly === false` — archive is editable today (personal `password-dashboard.tsx:406`; team `team-archived-list.tsx:508`); making it read-only regresses. Archive edit is gated by `adapter.permissions.canEdit`, like normal views. TRASH is read-only browse for ALL roles incl. OWNER (S6).
- **Forbidden patterns**: `pattern: isArchived\s*[:=]\s*(true|false)` introduced as a NEW literal switch inside the team page after refactor — reason: archive/trash selection must flow through descriptors, not re-hardcoded booleans.

### C3 — `EntryListView` shared component
- **File**: `src/components/passwords/detail/entry-list-view.tsx` (new). Extracted from current `PasswordList` + the team inline list + dashboard wiring.
- **Signature**:
  ```ts
  interface EntryListViewProps<E extends PasswordRowEntry & PasswordDetailPaneEntry> {
    adapter: VaultListAdapter<E>;
    descriptor: ListViewDescriptor;
    query: EntryListQuery;            // tag/folder/type for normal-family views
    searchQuery: string;
    sortBy: SortOption;
    refreshKey: number;
    onSelectedCountChange?: (count: number, allSelected: boolean, atLimit: boolean) => void;
    listRef?: React.Ref<EntryListHandle>;   // imperative handle: enterSelectionMode / exitSelectionMode / toggleSelectAll (F9)
    onDataChange?: () => void;
    onRequestEdit?: (entry: E) => void;     // container hosts the edit dialog (D4 pattern preserved)
    onRequestShare?: (entry: E) => void;    // container hosts the share dialog
  }
  ```
  NOTE (F9): `selectionMode` is NOT a prop — `EntryListView` OWNS it (along with `activeEntry`) so the view-change reset clears BOTH atomically (INV-F1). The parent's header "Select" button toggles it through `listRef`. Parent retains only header controls (search/sort) + dialogs.
- **Responsibilities** (moved OUT of PasswordList/team page, into here, ONCE):
  - Owns `activeEntry` AND `selectionMode` state; owns the view-change reset (clears both atomically on `query`/`descriptor.kind` change — INV-F1).
  - Owns `usePasswordEntryDetail(activeEntry?.id, { vaultStatus })` where **`vaultStatus` is DERIVED from `adapter.availability`** (`availability.ready ? UNLOCKED : LOADING`) so the pane decrypt is gated by the SAME signal as the list (S3 — prevents key-pending decrypt race). Renders `MasterDetailShell{ listSlot, detailSlot }`.
  - Renders `PasswordRow` (master-detail) or `PasswordCard` (accordion) per `useLayoutMode`.
  - Renders `PasswordDetailPane` with `key={activeEntry?.id ?? "none"}`, `readOnly={descriptor.detailReadOnly || !adapter.permissions.canEdit}`, `teamId={adapter.teamId}`.
  - Wires `useEntryActions(entry => adapter.buildGetDetail(entry))` for row callbacks (LAZY — the returned closure is invoked only on user copy/reveal events, never per-row at render — INV-S1/S4).
  - Wires `useBulkSelection` + `useBulkAction(adapter.bulkScope(descriptor.kind))`.
  - After a single-entry mutation: optimistically removes the row from `useEntryListData`'s list, calls the adapter method, reloads on rejection, and fires `notify*DataChanged` on success (INV-C1.4 / F5). For team, reuse `useTeamEntryMutations` for this (R1).
  - Renders availability gate card (locked → personal; key-pending → team) when `!adapter.availability.ready`, instead of the list (no fetch/decrypt — INV-C4.3).
  - Renders the trash destructive-row actions (restore / delete-permanently) + their confirm dialogs per C9, gated by `descriptor.rowActions` ∧ `adapter.permissions.canDelete` (team OWNER/ADMIN; personal unconditional — F4).
  - Renders empty-trash button when `descriptor.showEmptyTrashButton && adapter.permissions.canDelete` (F4: personal canDelete=true → shown to all; team → OWNER/ADMIN only, matching today).
  - On the favorites view (`descriptor.removeOnUnfavorite`), unfavoriting optimistically removes the row (F8).
  - Selection-mode detail-slot summary uses the canonical i18n key `selectedInPane` (F10; verify ja/en exist).
- **Invariants** — security (these are the WHOLE point; classified app-enforced unless noted):
  - **INV-S1 (single-plaintext residency)**: at most one entry's `InlineDetailData` resident at a time. Enforced by `usePasswordEntryDetail` deriving `detailData = unlocked && result.id === entryId ? … : null`. The view passes exactly the active `entryId`; no hover/prefetch decrypt.
  - **INV-S2 (key-remount)**: `PasswordDetailPane` mounted with `key={activeEntry?.id ?? "none"}` so reveal/reprompt state never carries across entries. Do NOT hoist `useReprompt`/reveal state above this boundary.
  - **INV-S3 (clear-on-lock by unmount — corrected per S2)**: there is NO separate team gate. BOTH the personal dashboard and the team page render as `children` of `src/app/[locale]/dashboard/layout.tsx`'s single `<VaultGate>` (gated on `useVault().status` — the personal vault status). `EntryListView` (and all pane/detail/plaintext state) MUST remain a descendant of THAT VaultGate in BOTH mounts; team plaintext residency clears via the same personal-status unmount. Do NOT hoist `EntryListView` into `layout.tsx` or into a provider above the gate. (Pre-existing, tracked: `clearAll` in `team-vault-core.tsx:154` is never called on lock; cached team CryptoKeys are non-extractable and hold no plaintext, so residency holds — `TODO(three-pane-structural-unification): call team clearAll on personal lock`.)
  - **INV-S4 (lazy-decrypt + bfcache lock)**: `adapter.buildGetDetail(entry)()` (the resolved promise) is invoked ONLY via the active-pane `usePasswordEntryDetail` and via `useEntryActions` user-event callbacks — never per-row at render, hover, or scroll (S4). Rely on the existing vault-context/`usePasswordEntryDetail` `pageshow` lock for bfcache; the refactor must not remove or bypass it.
  - **INV-S5 (selection-mode no-decrypt)**: entering selection mode clears `activeEntry`, sets the pane `entryId` to `null`, and renders the "N selected" summary — so `getDetailFor`/`buildGetDetail` is never invoked during bulk ops (preserve D7). Asserted by spying on the `getDetailFor` closure (call-count 0 in selection mode), not by render alone (T3).
  - **INV-S6 (role read-only — VIEWER, corrected per S5)**: edit/share/delete affordances gated by `adapter.permissions` AND `descriptor.rowActions` (intersection); pane `readOnly = descriptor.detailReadOnly || !permissions.canEdit`. Roles are OWNER/ADMIN/MEMBER/**VIEWER** (no "GUEST"); a VIEWER (canEdit=false) never sees edit/share/delete even if a descriptor enables it. TRASH pane is `readOnly` for ALL roles incl. OWNER (reveal blocked, no edit button — S6).
  - INV-F1 (app-enforced): changing `query` or `descriptor.kind` clears BOTH `activeEntry` and `selectionMode` atomically (preserve the prior PR's `viewKey` reset, INV-C4.2; F9 — single reset owner inside `EntryListView`).
  - INV-DEV1 (dev-time assert, gated by `process.env.NODE_ENV !== "production"` so it runs under Vitest — T5): on mount, assert no enabled `descriptor` row/bulk action lacks adapter support, reading `adapter.supportsFavorite` / `adapter.permissions` (never calling a throwing method — F7).
- **Forbidden patterns** (in addition to C1's list, targeting this file):
  - `pattern: buildGetDetail\([^)]*\)\(\)` appearing in a row-render / map / hover handler — reason: per-row eager decrypt violates INV-S1/S4.
  - `pattern: "GUEST"` — reason: not a real role; use VIEWER.

### C4 — `useEntryListData` hook
- **File**: `src/hooks/vault/use-entry-list-data.ts` (new). Extracted from PasswordList's fetch/decrypt/sort/search block.
- **Signature**:
  ```ts
  function useEntryListData<E extends PasswordRowEntry & PasswordDetailPaneEntry>(args: {
    adapter: VaultListAdapter<E>;
    view: EntryListViewKind;
    query: EntryListQuery;
    searchQuery: string;
    sortBy: SortOption;
    refreshKey: number;
  }): { entries: E[]; loading: boolean; error: Error | null; reload: () => void };
  ```
- **Invariants**:
  - INV-C4.1: calls `adapter.fetchOverviewEntries(view, query, signal)`; aborts the in-flight request on arg change (AbortController) — preserves PasswordList's cancellation behavior; no stale overwrite. (Tested by asserting `signal.aborted === true` on the superseded fetch's signal via a deferred-promise race — T6, not merely "second result wins".)
  - INV-C4.2: client-side search filter + sort applied AFTER decrypt, matching current `compareEntriesWithFavorite` / `compareEntriesByDeletedAt` selection by `descriptor.sort`.
  - INV-C4.3: when `adapter.availability.ready === false`, returns `entries: []` without fetching (no decrypt attempts while locked/key-pending).

### C5 — `PersonalVaultListAdapter`
- **File**: `src/lib/vault/personal-vault-list-adapter.ts` (new) + a `usePersonalVaultListAdapter()` hook colocated or in the personal dashboard.
- **Behavior**: reproduces today's personal PasswordList + TrashList data layer EXACTLY:
  - `fetchOverviewEntries`: GET `/api/passwords` with `?tag/folder/type/favorites/archived/trash` per view+query. Overview decrypt goes through a NEW shared helper **`decryptPersonalOverview(rawEntry, { encryptionKey, userId })`** (S1) — a single colocated function owning the one `buildPersonalEntryAAD(userId, id, VAULT_TYPE.OVERVIEW)` derivation + field map, symmetric to `mapDecryptedBlobToDetailFields`. For trash, decrypts the FULL overview shape (INV-C1.5/F2). Maps to `DisplayEntry` (extended with `deletedAt?: string`).
  - `buildGetDetail`: `buildPersonalGetDetail(entry, { encryptionKey, userId })`.
  - mutations (INV-C1.4: network-only, view owns optimistic/rollback/notify): PUT `/api/passwords/:id {isFavorite|isArchived}`, DELETE `/api/passwords/:id`, POST `/api/passwords/:id/restore`, DELETE `?permanent`, POST `/api/passwords/empty-trash`.
  - `availability`: `{ ready: !!encryptionKey, reason: "locked" }` (VaultGate already gates; ready=false is defense-in-depth, INV-C4.3).
  - `permissions`: all true (owner). `supportsFavorite: true`.
  - Decrypt-failure policy (F6): SKIP failed entries (`continue`), matching today's personal behavior.
- **Invariant**: INV-C5.1 — the personal `DisplayEntry` extension adds `deletedAt?` without breaking `PasswordRowEntry`/`PasswordDetailPaneEntry` conformance. INV-C5.2 — `decryptPersonalOverview` is the ONLY site deriving the personal `OVERVIEW`-scope AAD after this refactor (S1 acceptance).

### C6 — `TeamVaultListAdapter`
- **File**: `src/lib/vault/team-vault-list-adapter.ts` (new) + `useTeamVaultListAdapter(teamId, role)` hook.
- **Behavior**: reproduces today's team page + TeamArchivedList + TeamTrashList data layer EXACTLY:
  - `fetchOverviewEntries`: GET `apiPath.teamPasswords(teamId)` with `?archived/?trash`. Overview decrypt goes through a NEW shared helper **`decryptTeamOverview(teamId, rawEntry, { getEntryDecryptionKey })`** (S1) — single colocated owner of the per-entry `getEntryDecryptionKey` + `buildTeamEntryAAD(teamId, id, "overview", itemKeyVersion)` derivation + field map. For trash, decrypts the FULL overview shape (INV-C1.5/F2). Maps to the team entry type (extended with `deletedAt?`).
  - `buildGetDetail`: `buildTeamGetDetail(teamId, { id, entryType }, { getEntryDecryptionKey })`.
  - mutations (INV-C1.4): team API paths (`teamPasswordById` PUT/DELETE, `teamPasswordRestore` POST, `?permanent=true`, `teamPasswordsEmptyTrash` POST). Reuse `useTeamEntryMutations` for optimistic+notify rather than re-implementing (R1).
  - `availability`: `{ ready: hasTeamKey, reason: "key-pending" }` driven by the existing `keyPending` derivation. The view derives the pane's `vaultStatus` from this (S3).
  - `permissions` (reproduce `teams/[teamId]/page.tsx:303-306` VERBATIM): `canCreate/canEdit = OWNER|ADMIN|MEMBER`, `canDelete = OWNER|ADMIN` (also gates trash restore/delete-permanently + empty-trash — F4), `canShare` per current rule. Roles: OWNER/ADMIN/MEMBER/**VIEWER** (S5 — no "GUEST"); VIEWER gets all-false. `supportsFavorite: false`.
  - Decrypt-failure policy (F6): render a `"(decryption failed)"` PLACEHOLDER entry (preserve team behavior; do NOT skip), so the row count is stable and the key-distribution problem stays visible.
  - `setFavorite`: throws `AdapterUnsupportedError`; team descriptors set `rowActions.favorite=false` and `supportsFavorite=false` (INV-C2.1/INV-DEV1 reads the flag).
- **Invariant**: INV-C6.1 — team entry type keeps `createdBy` for the accordion `PasswordCard`; `EntryListView` passes it through opaquely (rides on concrete `E`). INV-C6.2 — `decryptTeamOverview` is the ONLY site deriving the team `"overview"`-scope AAD after this refactor (S1 acceptance); a round-trip test asserts it matches `team-entry-save.ts`'s overview ENCRYPT AAD.

### C9 — Trash/destructive row actions in the shared row (NEW — closes F1)
- **File**: `src/components/passwords/detail/entry-actions-menu.tsx` (modified) + `entry-list-view.tsx` (hosts the confirm dialogs).
- **Why**: `PasswordRow`/`EntryActionsMenu` today expose only edit/share/toggle-archive/delete-to-trash — NO restore, NO delete-permanently. Trash 3-pane via the shared row requires these affordances + their destructive confirmation dialogs (today implemented as bespoke per-row `<Dialog>`s in `trash-list.tsx:329` / `team-trash-list.tsx:380`).
- **Signature** (additive props on `EntryActionsMenu` / `PasswordRow`):
  ```ts
  // gated by descriptor.rowActions ∧ adapter.permissions.canDelete
  onRestore?: () => void;            // POST restore
  onDeletePermanently?: () => void;  // opens confirm dialog hosted by EntryListView, then DELETE ?permanent
  ```
- **Invariants**:
  - INV-C9.1: `onRestore`/`onDeletePermanently` render ONLY when `descriptor.rowActions.{restore,deletePermanently}` AND `adapter.permissions.canDelete` (team OWNER/ADMIN; personal unconditional — F4). A team MEMBER/VIEWER sees trash as a read-only list (no action buttons), matching today.
  - INV-C9.2: delete-permanently shows a destructive confirm dialog before the DELETE (preserve today's per-row confirm; R31 reviewer-confirm UX). Restore is non-destructive (no confirm), matching today.
  - INV-C9.3: in non-trash views these props are absent/undefined, so the shared row renders identically to today for normal/archive (no R8 regression).
- **Forbidden patterns**: `pattern: onDeleteRequest` wired in the TRASH descriptor path — reason: `onDeleteRequest` means "move to trash", nonsensical inside trash; trash uses `onDeletePermanently`.

### C7 — Wire personal dashboard to `EntryListView`
- **File**: `src/components/passwords/detail/password-dashboard.tsx` (modified); `src/components/passwords/detail/password-list.tsx` becomes a thin wrapper over `EntryListView` (or is absorbed); **delete `src/components/passwords/shared/trash-list.tsx`** (T1 — correct path).
- **Behavior**: `PasswordDashboard` constructs `usePersonalVaultListAdapter()`, selects descriptor by current view (normal/category/folder/tag → NORMAL_VIEW with query; favorites → FAVORITES_VIEW; archive → ARCHIVE_VIEW; trash → TRASH_VIEW), and renders ONE `<EntryListView>`. The personal **trash** path stops using `TrashList`; `TrashList` is deleted. Edit/share dialogs remain hosted by the dashboard (D4 preserved) via `onRequestEdit`/`onRequestShare`.

### C8 — Wire team page to `EntryListView` + delete bespoke team list components
- **File**: `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` (modified); **delete `src/components/team/management/team-archived-list.tsx` and `src/components/team/management/team-trash-list.tsx`** (T1 — correct paths).
- **Behavior**: team page constructs `useTeamVaultListAdapter(teamId, role)`, selects descriptor by tab (normal/archive/trash), renders ONE `<EntryListView>`. The inline ~470-line list orchestration is removed; team archive + team trash bespoke components are deleted. Team **trash becomes 3-pane** as a consequence (F-R2/task 2). Edit/share dialogs remain hosted by the team page.

## Acceptance criteria & consumer-flow walkthroughs

### Per-contract acceptance
- C1/C5/C6: for each view×vault, `fetchOverviewEntries` returns the same decrypted overview fields the current code produces for NON-trash views; for trash it returns the WIDENED full overview shape (INV-C1.5/F2 — intentional). `buildGetDetail` returns identical `InlineDetailData` to today. (VC3 parity check against dev DB; team path additionally has the T4 integration test.)
- S1: `grep -rn "VAULT_TYPE.OVERVIEW\|'overview'\|\"overview\"" src/lib src/components` shows the OVERVIEW-scope AAD derived in exactly ONE personal helper (`decryptPersonalOverview`) and ONE team helper (`decryptTeamOverview`) — no other list/adapter site. INV-C6.2 round-trip test passes.
- S3: with `adapter.availability.ready === false` and a non-null `activeEntry`, `usePasswordEntryDetail` is in a non-UNLOCKED state and `buildGetDetail` is never invoked (asserted by spy).
- S4/INV-S5: spy on the `getDetailFor` closure — call-count is 0 across list render and selection mode; non-zero only after an explicit copy/reveal user event on the active entry.
- S6/INV-S6: a VIEWER-role team adapter yields `canEdit=canDelete=canCreate=false`; the pane renders `readOnly`, and no edit/share/delete affordance renders for any view; TRASH pane is `readOnly` for OWNER too.
- C9: in TRASH_VIEW the shared row renders Restore + Delete-permanently (gated per INV-C9.1) with a destructive confirm on delete-permanently; in normal/archive the row is byte-identical to today (no restore/delete-perm rendered).
- C3: for every existing view, the rendered list, detail pane, selection, bulk bar, and dialogs are behaviorally identical to pre-refactor (F-R1/F-R2). Trash views additionally render the master-detail pane (new).
- C7/C8 (deletion — T1, importer-grep not bare symbol): `grep -rn "shared/trash-list\|team-archived-list\|team-trash-list" src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'` returns EMPTY (no importers); the three files are deleted; team page no longer contains inline overview-decrypt or inline master-detail wiring.

### Consumer-flow walkthroughs (mandatory — shape contracts C1/C2/C5/C6)
- **Consumer `EntryListView` (path: `entry-list-view.tsx`) reads from `adapter`** `{ availability, permissions, supportsFavorite, teamId, fetchOverviewEntries, buildGetDetail, setFavorite, setArchived, softDelete, restore, deletePermanently, emptyTrash, bulkScope }` and from `descriptor` `{ kind, rowActions, bulkActions, showEmptyTrashButton, detailReadOnly, removeOnUnfavorite, sort, emptyStateKey, apiQuery }`. It uses `availability.ready` to choose gate-card vs list AND to derive the pane `vaultStatus` (S3); `permissions.canEdit/Delete/Share` ∧ `rowActions.*` to choose row/menu affordances (incl. C9 restore/delete-perm gated by `canDelete`); `supportsFavorite` for INV-DEV1; `buildGetDetail` to feed `useEntryActions` AND `usePasswordEntryDetail`; `bulkScope(kind)` to construct `useBulkAction`; `teamId` to pass to `PasswordDetailPane`. **Every field listed is present in C1/C2/C9** — verified.
- **Consumer `useEntryListData` (path: `use-entry-list-data.ts`) reads from `adapter`** `{ availability.ready, fetchOverviewEntries }` and from args `{ view, query, searchQuery, sortBy, refreshKey }`; uses `fetchOverviewEntries(view, query, signal)` to load, `descriptor.sort` (passed in) to pick the comparator. All present — verified.
- **Consumer `useEntryActions` (existing, path: `use-entry-actions.ts`) reads** the injected `getDetailFor = entry => adapter.buildGetDetail(entry)`; uses it to lazily decrypt on copy/reveal. `buildGetDetail` present in C1 — verified. No new field needed (existing seam).
- **Consumer `PasswordDetailPane` (existing) reads** `{ entryId, entry (PasswordDetailPaneEntry), detailData, loading, error, onEdit?, onRefresh?, teamId?, readOnly? }`. `EntryListView` supplies `teamId` from `adapter.teamId`, `readOnly` from `descriptor.detailReadOnly || !permissions.canEdit`. All satisfiable from C1/C2 — verified.
- **Consumer accordion `PasswordCard` (existing) reads** the concrete `E` incl. team-only `createdBy`. Because `E` is the concrete adapter entry type (not the minimal interface), `createdBy` rides through. Personal `E` has no `createdBy`; `PasswordCard`'s `createdBy` prop is optional today — verified no break.

## Go/No-Go Gate

| ID  | Subject                                                        | Status  |
|-----|---------------------------------------------------------------|---------|
| C1  | `VaultListAdapter<E>` interface + availability/permissions    | pending |
| C2  | `ListViewDescriptor` + NORMAL/ARCHIVE/TRASH descriptors       | pending |
| C3  | `EntryListView` shared component (owns master-detail+security)| pending |
| C4  | `useEntryListData` fetch/decrypt/sort/search hook             | pending |
| C5  | `PersonalVaultListAdapter`                                    | pending |
| C6  | `TeamVaultListAdapter`                                        | pending |
| C7  | Wire personal dashboard; delete personal `TrashList`          | pending |
| C8  | Wire team page; delete team archive/trash bespoke components  | pending |
| C9  | Trash/destructive row actions in shared `EntryActionsMenu`     | pending |

All contracts are `pending` until plan review closes. No transition to Phase 2 until every contract reads `locked`.

## Testing strategy

- **Test-quality bar (T11)**: every migrated/new clear-, capability-, and gate-test follows positive-precondition → trigger → assert (mutation-resistant per the prior PR's T6). A test that still passes with its final assertion removed is rejected.
- **Unit (Vitest)**:
  - New `entry-list-view.test.tsx` (mock adapter MUST be fully typed `const adapter: VaultListAdapter<DisplayEntry> = {…}` — no `as any`/`Partial`, so shape drift is a compile error — T8): assert (a) gate card when `availability.ready=false`; (b) `key={entryId}` remount on activate change (INV-S2, port `password-detail-pane.test.tsx:192`); (c) **INV-S5/S1 without mocking `usePasswordEntryDetail` away** — spy on the `getDetailFor` closure and assert call-count 0 during list render + selection mode, and assert the `entryId` arg fed to the detail hook transitions A→B→null (never two ids); selection mode sets it null (T3); (d) read-only pane in TRASH for ALL roles incl. OWNER, editable pane in ARCHIVE for an editor (F3/S6); (e) INV-DEV1 — matched descriptor does NOT throw (precondition) THEN a mismatched one throws, under `NODE_ENV=test` (T5); (f) BOTH layout branches by mocking `useLayoutMode` accordion→PasswordCard / master-detail→PasswordRow (port `password-list.test.tsx:199-242` — T7); (g) C9 trash row: restore/delete-perm render only when `rowActions.{…}` ∧ `canDelete`; delete-perm shows confirm; normal/archive rows unchanged.
  - New `use-entry-list-data.test.ts`: abort-on-arg-change asserting `signal.aborted` via deferred-promise race (INV-C4.1/T6); no-fetch-when-not-ready (INV-C4.3); comparator selection by `descriptor.sort`.
  - New `personal-vault-list-adapter.test.ts` / `team-vault-list-adapter.test.ts`: mutation methods hit correct API paths/methods (and are network-only — no list mutation, INV-C1.4); `setFavorite` throws on team and `supportsFavorite=false`; the REAL team descriptor set excludes `favorite` (T9); returned `E` for trash includes `deletedAt` (T8); decrypt funnels through `decryptPersonalOverview`/`decryptTeamOverview` + existing `build*GetDetail`; team `permissions` for a VIEWER are all-false (S5).
  - **Coverage-migration table (T2)** — every assertion in a deleted component's test re-homed (NOT silently dropped); `trash-list-bulk-restore.test.ts` is a source-string grep test → **DELETE, re-express behaviorally**:

    | Current assertion (file) | New home |
    |---|---|
    | team cross-tenant no-leak (`team-trash-list.test.tsx:197`, `team-archived-list.test.tsx:259`) | `team-vault-list-adapter.test.ts` (wrong-tenant context → empty, no leak) |
    | decrypt-failure → `"(decryption failed)"` placeholder (both team tests) | `team-vault-list-adapter.test.ts` (`fetchOverviewEntries` marks failed, does not skip — F6) |
    | role-gated empty-trash hidden for MEMBER (`team-trash-list.test.tsx:152`) | `entry-list-view.test.tsx` (descriptor.showEmptyTrashButton ∧ canDelete) |
    | personal empty-trash-confirm + delete-permanently-confirm | `entry-list-view.test.tsx` — **NET-NEW coverage** (currently UNTESTED — R30; flag as new, not migrated) |
    | personal trash empty-state + decrypt (`trash-list.test.tsx`) | `entry-list-view.test.tsx` (trash view) |
  - Keep `buildPersonalGetDetail`/`buildTeamGetDetail`/`map-detail-fields`/`use-password-entry-detail`/`use-entry-actions` tests unchanged.
- **Integration (real-DB, T4 — central gap, carried forward from prior PR's R16 requirement)**: a seeded team with a distributed member key. Assert `teamVaultListAdapter.fetchOverviewEntries("normal"|"archive"|"trash", …)` returns overview fields byte-identical to the pre-refactor inline path for ≥1 entry of ≥2 entry types (the moved per-entry ItemKey-unwrap overview decrypt is the [[project_integration_test_gap]] hot spot). This path MUST NOT be `blocked-deferred`: if the CI seeded-team is unavailable, escalate to a hard manual gate with a named owner. Existing personal+team integration tests must also pass unchanged.
- **Manual (browser, VC1–VC4)** — `*-manual-test.md` (Phase 2; R35 Tier-1 UI). Two-filter scoped: EXCLUDE anything unit covers (filter A) — e.g. the key-pending gate-card RENDER is a unit test (VC4), so list only the *real pending-member state-production* end-to-end (T10). Human-need items (filter B): responsive master-detail↔accordion both vaults (VC1); clear-on-lock unmount + bfcache back/forward (VC2); team role read-only with a real VIEWER; trash 3-pane restore/delete-perm/empty in both vaults; archive edit parity.
- **No silent caps**: if a view's parity cannot be browser-verified locally, log it `blocked-deferred` with justification — EXCEPT the T4 team-overview-decrypt path, which is never deferrable.

## Considerations & constraints

- **High regression surface on security-critical UI.** Mitigation: Candidate B keeps ALL pane/decrypt/lock wiring in ONE component; batch so the app stays green after each batch. Personal first (reference behavior, full unit coverage), team second.
- **Trash 3-pane is real work, not incidental (F1).** It requires C9 (shared destructive-row affordances + confirm dialogs) before either trash batch — hence Batch 2.5 below.
- **Implementation batches** (each ends with `vitest run` + `next build`):
  1. C1+C2 types/descriptors (compile-only, no behavior change).
  2. C4 `useEntryListData` + C3 `EntryListView` + C5 `decryptPersonalOverview` extracted from `PasswordList` for the **personal normal/favorites/archive** path; `PasswordList` becomes a wrapper. Verify personal parity (incl. archive EDITABLE — F3).
  2.5. **C9** — add restore/delete-permanently affordances + confirm dialogs to `EntryActionsMenu`/`EntryListView`, gated by descriptor; verify normal/archive rows unchanged (INV-C9.3). MUST land before any trash batch.
  3. C5 trash via TRASH_VIEW (widened overview decrypt — F2); wire C7; delete `shared/trash-list.tsx`. Verify personal trash 3-pane.
  4. C6 `TeamVaultListAdapter` + `decryptTeamOverview`; wire C8 team normal/archive; delete `team-archived-list.tsx`. Verify team parity + S3 key-pending gating.
  5. Team trash via TRASH_VIEW; delete `team-trash-list.tsx`. Verify team trash 3-pane + role gating (F4).
  6. Test migration table (T2) + T4 integration test + manual-test artifact + `scripts/pre-pr.sh`.
- **Branch/PR**: ONE PR ([[feedback_pr_cadence_aggregate]]), branched from `main` **after PR #515 merges** (the shared sub-components this builds on land in #515). Until then the plan is reviewed but not committed to a branch.

### Scope contract (out-of-scope, ID'd)
- **SC1** — Emergency-access vault browse 3-pane. Owns: future follow-up. The adapter seam (C1) is designed to admit it later, but no emergency adapter is built here.
- **SC2** — Extension / iOS / CLI list surfaces. Out of scope; this is the web app only. AAD parity guards ([[project_aad_three_implementations]]) are unaffected — no AAD derivation changes (adapters call the SAME existing `build*GetDetail` + AAD helpers).
- **SC3** — Any change to encryption format, API response shape, or DB schema. NONE. This is a pure client-side component refactor; adapters call existing endpoints with existing query params.
- **SC4** — Server-side search/sort. Search+sort remain client-side post-decrypt exactly as today (INV-C4.2).

## User operation scenarios

1. **Personal, desktop, normal view**: list left, click entry → detail right; edit from pane → dialog; archive from row menu → entry leaves list, pane clears.
2. **Personal, narrow viewport**: accordion cards, inline detail; resize wide → master-detail (VC1).
3. **Personal trash**: now master-detail; select an entry → read-only detail (confirm contents before purging); restore / delete-permanently / empty-trash all work (F-R3).
4. **Team member (MEMBER role), normal**: 3-pane, can edit/create; cannot permanently delete (button hidden, INV-S6).
5. **Team VIEWER**: read-only pane, no edit/share/delete affordances (canEdit=canDelete=false).
6. **Team, key not yet distributed**: key-pending gate card instead of list; no decrypt attempts (F-R6/INV-C4.3).
7. **Team archive + team trash**: both master-detail; unarchive/restore/empty work; descriptor drives which actions appear.
8. **Lock during browse**: vault locks → VaultGate unmounts EntryListView → resident plaintext gone (INV-S3); back/forward (bfcache) forces re-lock (INV-S4).
