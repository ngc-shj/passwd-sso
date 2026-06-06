# Plan: three-pane-vault-layout

Desktop password vault: add a 3-pane master-detail layout (`sidebar | list | detail`) for wide
viewports, while preserving the existing accordion behavior for narrow / mobile viewports.

## Project context

- **Type**: web app (Next.js 16 App Router + TypeScript + Tailwind 4 + shadcn/ui). E2E-encrypted vault.
- **Test infrastructure**: unit (vitest) + integration (real-DB) + E2E (Playwright) + CI/CD.
- **Verification environment constraints** (each contract's manual-test path is classified against these):
  - **VC1** — Breakpoint behavior (3-pane at `xl`, list+detail at `lg`, accordion `< lg`) requires manual
    browser resize across ≥3 widths. `verifiable-local` (dev server + window resize); not exercisable by
    jsdom unit tests (no layout engine). Playwright can assert presence/visibility at fixed viewport sizes.
  - **VC2** — Vault unlock + client-side decryption of a real entry requires an unlocked vault with a
    real `encryptionKey` and seeded entries. `verifiable-local` (dev DB + `npm run db:seed` + manual unlock).
    Unit tests mock `fetchDecryptedEntry`; they cannot prove real AES-GCM round-trip.
  - **VC3** — Auto-lock clear-on-idle (C1 invariant INV-C1.3) fires on a real wall-clock timer
    (`auto-lock-context.tsx`, idle/hidden windows). Must be verified with **real timers**, not fake timers
    (per Expert Agent Obligations — runtime-jitter rule). `verifiable-local` but slow; a shortened test
    timeout override is acceptable for the unit test, with one real-clock manual confirmation.
  - **VC4** — Keyboard navigation focus traversal (C7) across list↔detail is `verifiable-local` + Playwright
    keyboard events; jsdom focus semantics are partial, so a Playwright assertion is the authoritative path.

## Objective

Improve desktop (PC) UX for browsing and inspecting vault entries by introducing a persistent
master-detail layout on wide screens, without regressing the narrow-viewport accordion experience and
without weakening the E2E-encryption plaintext-lifetime guarantees the accordion currently provides.

## Requirements

### Functional
- On `xl` and wider, the personal dashboard renders three regions: nav sidebar, entry list, detail pane.
- Selecting an entry in the list shows its decrypted detail in the detail pane (replaces prior selection).
- On `lg` (1024–1280px), render list + detail (detail as a 2nd column or slide-over); nav sidebar may
  collapse to the existing Sheet.
- On `< lg` and all mobile widths, behavior is unchanged: single-column list with inline accordion expand.
- Keyboard: `↑`/`↓` move selection in the list, `Enter` / `Tab` focus the detail pane, `Esc` returns
  focus to the list. (Currently absent — see C7.)
- Edit/Delete/Share remain modal dialogs (unchanged), launchable from both the list row menu and the pane.
- Empty detail state ("select an entry") shown on first load, after delete, and when no entry is selected.
  No auto-select on load.

### Non-functional (security)
- At most ONE entry's plaintext is resident at any time (preserve the accordion's single-decrypt invariant).
- No prefetch / hover-decrypt / multi-entry cache.
- Decrypted plaintext is cleared from state when: the vault leaves `UNLOCKED` (lock / auto-lock), the
  active view/tag/folder/type changes, and when the selected entry is removed by an optimistic mutation.
- Detail pane is keyed by entry id so reveal / reprompt timers never carry across selections.

## Technical approach

### Architecture

The decrypt + handler logic currently lives **inside** `PasswordCard`'s `expanded &&` block
(`src/components/passwords/detail/password-card.tsx`), duplicated in behavior across four consumers
(personal list, team page, team-archived list, emergency-access vault). The plan extracts that logic into
ONE shared hook + ONE shared pane component, then layers the 3-pane layout on top of the personal
dashboard only. The accordion path and the 3-pane path consume the **same** extracted code, eliminating
the personal-vs-team divergence hazard.

```
usePasswordEntryDetail (C1)  ← owns fetch/decrypt/clear lifecycle + security invariants
        │
        ├── PasswordDetailPane (C2)  ← presentational; empty-state + PasswordDetailInline; key={entryId}
        │        │
        │        ├── consumed by PasswordCard accordion (C3, behavior-preserving)
        │        └── consumed by 3-pane layout (C5)
        │
PasswordDashboard (C4) ← owns activeEntry; renders list (C6 compact rows) + pane as siblings at xl/lg
        │
        └── keyboard nav (C7)
```

### Commonization principle (user directive — overrides personal-only coupling)

**Both the UI (screens/components) AND the logic (processing) MUST be commonized across personal and team
vaults; no personal-only path that team must re-implement in parallel** (cf. project_extension_parallel_impl).
Concretely, every shared artifact in this plan is built **vault-agnostic**, parameterized by an injected
`getDetail` closure + vault key/lock source (`useVault()` vs `useTeamVault()`), with ZERO per-vault
field-mapping in the shared layer:
- C1 `usePasswordEntryDetail` (hook) — vault-agnostic via injected `getDetail` (INV-C1.7).
- C2 `PasswordDetailPane` (pane) — presentational, vault-agnostic.
- C5 **`MasterDetailShell`** (the 3-pane layout container) — extracted as a REUSABLE component that BOTH the
  personal dashboard and (later) the team page mount; NOT inlined into `PasswordDashboard` (INV-C5.6).
- C6 `PasswordRow` + the per-entry-type secondary-line renderer + copy/menu cluster — shared sub-components
  consumed by personal AND team rows (INV-C6.4).
- C7 keyboard nav — operates on the vault-agnostic list/pane, not personal-specific state.

This makes SC1 (team/emergency 3-pane) a **wiring task** (point the team data source + team `getDetail` at the
same `MasterDetailShell`), not a parallel build.

### Scope decision

The 3-pane **layout is wired up for the personal dashboard only** in this PR; the shared `MasterDetailShell`
+ C1/C2/C6 components are built vault-agnostic so team/emergency adoption is later wiring (SC1), not a second
implementation. Team page, team-archived list, and emergency-access vault keep the accordion in THIS PR but
already consume the shared C1/C2/C6 code (inheriting the clear-on-lock fix + commonized rendering).
`activeEntry` is **client React state, not a URL param** (SC2 — deep-linking deferred; avoids browser-history
entry-id metadata leak).

## Contracts

### C1 — `usePasswordEntryDetail` hook (decrypt lifecycle + security invariants)

- **Signature**:
  ```ts
  function usePasswordEntryDetail(
    entryId: string | null,
    opts: {
      // getDetail returns the COMPLETE InlineDetailData (the hook does ZERO field-mapping).
      // The personal closure assembles it from the raw API row + entry-prop fallbacks exactly as
      // password-card.tsx:342-399 does today (requireReprompt ?? prop, urlHost from prop,
      // createdAt/updatedAt from raw, passwordHistory). The team/emergency closures already return a
      // fully-formed InlineDetailData (teams/[teamId]/page.tsx:423-491) and own their own key access via
      // useTeamVault — so encryptionKey is NOT passed here.
      getDetail: (id: string) => Promise<InlineDetailData>;
      vaultStatus: VaultStatus;   // from useVault() (personal/emergency) or the team vault's lock signal
    }
  ): {
    detailData: InlineDetailData | null;
    loading: boolean;
    error: Error | null;
    invalidate: () => void;       // forces a re-fetch (used by edit-onSaved / refresh, see F2)
  }
  ```
  No body in this plan (extraction of existing logic, not a novel algorithm). The hook gates fetching ONLY
  on `entryId != null`; all key material and AAD construction live inside the injected `getDetail` closure
  (so the personal E2E `buildPersonalEntryAAD` path and the team `buildTeamEntryAAD` path are each preserved
  verbatim by their own closure — no decrypt-path divergence; see INV-C1.7).
- **Invariants**:
  - **INV-C1.1** (app-enforced): when `entryId` changes, the previous entry's `detailData` is set to `null`
    BEFORE the new fetch resolves — at most one decrypted entry resident at a time. (Matches the accordion's
    `!expanded → setDetailData(null)` semantics, password-card.tsx:310-316.)
  - **INV-C1.2** (app-enforced): no decryption is triggered except by an `entryId` that the user explicitly
    selected/expanded (incl. keyboard arrow-nav, which is an explicit user action — see C7 note). No
    hover/scroll/prefetch path may call `getDetail`.
  - **INV-C1.3** (app-enforced, **NEW behavior — not preserved from the accordion**): the **primary**
    clear-on-lock mechanism is the `VaultGate` unmount (vault-gate.tsx:50-52 early-returns `<VaultLockScreen>`
    on `LOCKED`, tearing down the entire dashboard subtree incl. all `detailData`). The accordion does NOT
    clear `detailData` on lock today (only on `!expanded`, password-card.tsx:310-316) — relying on the same
    unmount. As **defense-in-depth**, the hook ALSO clears `detailData` via an effect when `vaultStatus`
    leaves `UNLOCKED` OR the vault key becomes null. The effect is secondary; the unmount is load-bearing.
  - **INV-C1.4** (app-enforced): an out-of-order fetch resolution for a stale `entryId` must not overwrite
    current `detailData` (the existing `cancelled` flag pattern, password-card.tsx:322,407-409, is preserved
    inside the hook).
  - **INV-C1.5** (app-enforced, placement): the hook's state holder and the detail pane MUST render INSIDE
    the `VaultGate` UNLOCKED subtree. `activeEntry` / `detailData` MUST NOT be hoisted into
    `dashboard/layout.tsx` or any component above `VaultGate` — doing so removes the unmount guarantee
    (INV-C1.3) and leaves the secondary effect as the only defense, which has a one-render exposure window.
  - **INV-C1.6** (app-enforced, bfcache): on a bfcache restore (`pageshow` with `event.persisted === true`),
    if the restored client key is null (`secretKeyRef`/`encryptionKey` was zeroed on `pagehide`,
    vault-context.tsx:282) while `vaultStatus` still reads `UNLOCKED`, the app must force a **client LOCK
    transition** (status → LOCKED), NOT a server vault-status re-check. A re-check would hit the
    "never overwrite UNLOCKED" rule (vault-context.tsx:213) and no-op, leaving the pane showing decrypted
    state with a zeroed key (S7). The forced LOCK MUST call the existing `lock()` (vault-context.tsx:248-265),
    NOT a bare `setVaultStatus(LOCKED)` — its UNIQUE benefit over a bare status set is that it zeroes
    `wrappedKeyRef`/salt/ECDH-public AND clears `encryptionKey`, which `pagehide`'s `zeroSensitiveKeys`
    (vault-context.tsx:269-287) does NOT do (pagehide only zeroes `secretKeyRef`/ECDH-private, leaving
    `wrappedKeyRef`/salt resident) (S11/S13). `lock()`'s delegation-revoke is idempotent here (pagehide
    already revoked) and harmless. The LOCK makes `VaultGate` unmount the pane. There is currently no
    `pageshow` handler anywhere in the codebase — this is net-new code (T11).
  - **INV-C1.7** (app-enforced, no decrypt-path divergence): the personal (`buildPersonalEntryAAD`) and team
    (`buildTeamEntryAAD`) decrypt paths each remain entirely inside their own `getDetail` closure; the hook
    contains no per-path branch. (This is the structural guarantee behind C3's INV-C3.1.)
- **Forbidden patterns**:
  - `pattern: onMouseEnter=\{.*getDetail` — reason: no hover prefetch (INV-C1.2)
  - `pattern: prefetch.*[Dd]ecrypt` — reason: no prefetch decryption (INV-C1.2)
  - `pattern: setDetailData\(` outside `use-password-entry-detail.ts` — reason: detail state ownership lives
    only in C1; consumers use `invalidate()` (F2), never a direct setter.
- **Acceptance criteria**:
  - Selecting entry A then B leaves only B's plaintext in state (A's `detailData` is null/GC-eligible).
  - Locking the vault unmounts the pane (primary); a forced `vaultStatus`→non-UNLOCKED transition with the
    pane still mounted clears `detailData` within one render (defense-in-depth).
  - Rapid A→B→A selection never renders A's detail under B's id (cancel-flag race covered, INV-C1.4).
  - Editing the open entry then saving re-decrypts via `invalidate()` — the pane never shows stale plaintext.
- **Consumer-flow walkthrough**:
  - Consumer `PasswordCard` (path: `src/components/passwords/detail/password-card.tsx`) reads
    `{ detailData, loading, invalidate }`, renders the accordion body when `expanded`, and calls
    `invalidate()` from edit-onSaved (replaces the current `setDetailData(null)` at :928) and from refresh
    (replaces :909). Passes a personal `getDetail` closure that assembles the full `InlineDetailData` from
    `raw` + entry-prop fallbacks (requireReprompt/urlHost/createdAt/updatedAt/passwordHistory).
  - Consumer `PasswordDetailPane` (path: new `src/components/passwords/detail/password-detail-pane.tsx`)
    reads `{ detailData, loading, error, invalidate }`; uses `detailData` identically to the accordion,
    `error`/`loading` for error/skeleton states, and `invalidate` for edit-onSaved.
  - Consumer `teams/[teamId]/page.tsx` and `team-archived-list.tsx` pass a team `getDetail` closure that
    returns a fully-formed `InlineDetailData` (key access via `useTeamVault()`, NOT `useVault().encryptionKey`)
    and the team vault's lock signal as `vaultStatus`. Read `{ detailData, loading, invalidate }` identically.
  - Consumer `emergency-access/[id]/vault/page.tsx` passes its blob-decrypt `getDetail`; the whole page is
    already gated on `vaultStatus !== UNLOCKED` (vault/page.tsx:334), so INV-C1.3's effect is redundant but
    harmless there.
  - All consumers require ONLY fields already on the existing `InlineDetailData` shape — no new field; the
    shape is satisfiable for every consumer because each consumer's `getDetail` produces the complete object.

### C2 — `PasswordDetailPane` component (presentational pane + empty state)

- **Signature**:
  ```ts
  function PasswordDetailPane(props: {
    entryId: string | null;
    detailData: InlineDetailData | null;
    loading: boolean;
    error: Error | null;
    onEdit: () => void;       // launches existing modal
    onCopyField: (field: CopyableField) => void;
    // ...same action callbacks PasswordDetailInline already receives
  }): JSX.Element
  ```
- **Invariants**:
  - **INV-C2.1** (app-enforced): rendered with `key={entryId}` by its parent so reveal/reprompt timer state
    (`use-reveal-timeout.ts`, `use-reprompt.ts`) resets per selection and never carries across entries.
    This `key` is the ENTIRE defense against cross-entry reveal carry-over (S5) — it is a hard acceptance
    assertion (see Acceptance + Testing), not merely an advisory regex.
  - **INV-C2.2** (app-enforced): when `entryId === null`, renders the empty-state ("select an entry"),
    never a stale previous entry.
  - **INV-C2.3** (app-enforced): the `useReprompt` 30s verification cache (use-reprompt.ts:6, a `useRef`
    Map) MUST stay inside the `key={entryId}` boundary so it is torn down per selection AND per lock-unmount.
    It MUST NOT be hoisted above the keyed boundary; if it ever is, it must be explicitly invalidated on
    `entryId` change and on `vaultStatus !== UNLOCKED`.
- **Forbidden patterns**:
  - `pattern: PasswordDetailPane(?!.*key=)` — reason: must be keyed by entryId (INV-C2.1). (Manual review;
    regex is advisory — the hard guarantee is the acceptance/test assertion below.)
- **Acceptance criteria**:
  - `entryId === null` → empty-state visible, no decrypted fields rendered.
  - Reveal a password on entry A, switch to B: B renders masked (no carried-over revealed state). This
    assertion is mutation-resistant: it first asserts A is revealed, then switches, then asserts B masked —
    removing the final assertion leaves an unconsumed precondition (T6).
- **Consumer-flow walkthrough**:
  - Consumer `PasswordDashboard` (path: `src/components/passwords/detail/password-dashboard.tsx`) passes
    `entryId={activeEntry?.id ?? null}` + the hook's `{detailData, loading, error}` + the existing action
    callbacks; reads nothing back (presentational). Renders `<PasswordDetailPane key={activeEntry?.id} .../>`
    in the 3-pane region.

### C3 — `PasswordCard` refactor (behavior-preserving extraction, 4-consumer lockstep)

- **Signature**: unchanged public props. Internally, the `expanded &&` detail block is replaced by a call
  to `usePasswordEntryDetail` (C1) + render via `PasswordDetailInline` (or `PasswordDetailPane` body).
- **Invariants**:
  - **INV-C3.1** (app-enforced): the hook holds NO per-path branch — each consumer injects a `getDetail`
    closure that returns a COMPLETE `InlineDetailData` (personal assembles from `raw` + prop fallbacks; team
    returns its fully-formed object via `useTeamVault`). Divergence is structurally impossible because the
    hook never assembles fields (INV-C1.7). password-card.tsx:337-405 (personal field assembly) moves INTO
    the personal `getDetail` closure, NOT into the hook.
  - **INV-C3.2** (app-enforced): all four consumers (personal `password-list.tsx`, team `teams/[teamId]/
    page.tsx`, `team-archived-list.tsx`, emergency `emergency-access/[id]/vault/page.tsx`) continue to pass
    their existing props and observe unchanged accordion behavior after the refactor.
- **Forbidden patterns**:
  - `pattern: setDetailData\(` outside `use-password-entry-detail.ts` — reason: detail state ownership lives
    only in C1.
- **Acceptance criteria**:
  - Existing accordion tests (`password-list-*`, `entry-list-shell.test`) pass for all 4 consumers AFTER the
    test-migration below (NOT "unchanged" — the mock boundary moves; see test-migration).
  - Team and personal entries both decrypt and render correctly through the single extracted hook, with
    `requireReprompt`/`urlHost`/`createdAt`/`updatedAt`/`passwordHistory` correct on the personal path.
- **Test migration (T3 — mandatory, lockstep with the refactor)**:
  - The decrypt-layer mocks (`@/lib/crypto/crypto-client` `decryptData`, `crypto-aad`, `fetchApi`) currently
    in `password-card.test.tsx:28-39` exercise logic that moves into the hook. They are RE-CREATED in the new
    `use-password-entry-detail.test.tsx` (on the hook's real call path, RT5) AND **explicitly DELETED from
    `password-card.test.tsx`** (not merely "moved" — leaving them behind reproduces the dead-mock shape one
    layer up, T14).
  - `password-card.test.tsx` keeps ONLY prop-based assertions: render, click→`onToggleExpand` (PasswordCard's
    public prop is UNCHANGED per C4's T14 resolution — this test is NOT migrated), favorite. The
    `onActivate`/`activeEntryId` rename is tested in `password-list.test.tsx` (the list↔dashboard boundary).
  - The hook test MUST assert on the hook's returned `detailData` (the real consumer of `getDetail`) — e.g.
    `expect(result.current.detailData).toEqual(<resolved>)`, and `null` before resolution / after clear — NOT
    re-stub a presentational sink. Today `password-card.test.tsx` stubs `PasswordDetailInline` to a `<div>`,
    so the current decrypt mocks never reach a rendered field; moving them without asserting on `detailData`
    would reproduce the dead-mock shape one layer down (T10, RT5).
  - `password-list.test.tsx` (PasswordCard fully mocked, decrypt mock at :24-41) is re-checked: confirm the
    list-level decrypt mock is not silently dead after extraction.
  - Reject any post-refactor test that keeps a decrypt mock for a code path that no longer runs (silent
    false-green).

### C4 — Unified active-entry model (`activeEntry`) + `PasswordList` props

**Architectural decision (R2 — resolves F11/F12/F13/F14/T9 at the root):** accordion-expand and
pane-select are the SAME primitive — exactly one active entry, click toggles. They are unified into a single
`activeEntry` owned by `PasswordDashboard`; `layoutMode` only changes how the active entry is *rendered*
(inline below the row vs in the right pane). There is no separate `expandedId`/`selectedId` split, so no
cross-component bridge is needed (F13 dissolves), and because the dashboard holds the full overview row it
can construct the personal `getDetail` closure (F11/F14 dissolve). `expandedId` is REMOVED from
`PasswordList` (password-list.tsx:113) and lifted as `activeEntry` to the dashboard.

- **Signature**:
  ```ts
  // PasswordDashboard owns the single source of truth:
  //   const [activeEntry, setActiveEntry] = useState<EntryOverview | null>(null)
  // The active-entry row IS the existing `DisplayEntry` type PasswordList already holds in allEntries
  // (password-list.tsx:111,152-179) — reuse it (or a `Pick<DisplayEntry, ...>`), do NOT introduce a new
  // parallel `EntryOverview` type (avoids a second source-of-truth for row shape, F19). It carries
  // id/title/entryType/username/urlHost/tags/requireReprompt. The dashboard's personal getDetail closure
  // (C1) reads entryType/urlHost/requireReprompt/title from it + fetches the raw blob by id.
  type PasswordListProps = { /* existing */ } & {
    activeEntryId?: string | null;                 // = activeEntry?.id ?? null
    onActivate?: (entry: EntryOverview | null) => void;  // carries the OVERVIEW ROW, not a bare id
    onEntryRemoved?: (id: string) => void;         // fired by every optimistic/bulk removal site (F12)
    layoutMode: "accordion" | "master-detail";
  }
  ```
- **Invariants**:
  - **INV-C4.1** (app-enforced): row click calls `onActivate(entry)` (toggling off if already active) in BOTH
    modes. `layoutMode` decides rendering: `accordion` expands inline below the row; `master-detail` renders
    the right pane. In `master-detail` WHILE `selectionMode` is active, row click routes ONLY to the bulk
    checkbox toggle (`onToggleSelectOne`) and `onActivate` is a no-op (resolves the triple click-overload, F5).
  - **INV-C4.2** (app-enforced): when the active view/tag/folder/entryType changes, `activeEntry` resets to
    `null` by adding `setActiveEntry(null)` INSIDE the existing during-render `if (prevViewKey !== viewKey)`
    block (password-dashboard.tsx:139-142) — NOT a separate effect (a separate effect clears one frame late,
    briefly showing a stale pane, F7).
  - **INV-C4.3** (app-enforced): two distinct clearing mechanisms by removal kind (F12/F16):
    - **Single-entry optimistic** (`handleToggleFavorite` password-list.tsx:256 unfavorite-in-favorites,
      `handleToggleArchive` :282, `handleDelete` :297): each fires `onEntryRemoved(id)` (the id is in scope
      and the `filter` is synchronous); the dashboard runs `if (id === activeEntry?.id) setActiveEntry(null)`.
    - **Bulk** (`useBulkAction.onSuccess` :249-253 + empty-trash): `onSuccess` is zero-arg and runs
      `clearSelection()` first, so per-id signalling is NOT available there (F16). Instead, AFTER the
      `fetchPasswords()` re-fetch settles, `PasswordList` (which owns `allEntries`) checks whether
      `activeEntryId` still exists in the refreshed list; if absent it calls `onActivate(null)`. The
      membership check MUST run in `PasswordList`, not the dashboard (the dashboard cannot see `allEntries`).
  - **INV-C4.4** (app-enforced): during selection mode (bulk multi-select), the detail pane shows a
    "N selected" summary + bulk actions instead of a single decrypted entry — NO single-entry `getDetail`
    decrypt is triggered while in selection mode.
- **PasswordCard public props UNCHANGED (T14 resolution)**: `PasswordCard` keeps its existing `expanded` /
  `onToggleExpand(id)` props (C3 "unchanged public props" stands — lowest blast radius across 4 consumers).
  The unification happens ONLY at the `PasswordList`↔dashboard boundary. `PasswordList` maps internally:
  `expanded={activeEntryId === entry.id && layoutMode === "accordion"}` and
  `onToggleExpand={(id) => onActivate(entryById(id))}`. Consequently the 3 SC1 consumers (team/team-archived/
  emergency) and `password-card.test.tsx:132-152` (`onToggleExpand` assertion) are UNTOUCHED.
- **Forbidden patterns**:
  - `pattern: expandedId` **scoped to `src/components/passwords/detail/password-list.tsx` ONLY** (F18) —
    reason: replaced by the lifted `activeEntry` there. A repo-wide grep would false-positive on the 3
    SC1-deferred consumers (vault/page.tsx:84, teams/[teamId]/page.tsx:107, team-archived-list.tsx:81), which
    legitimately keep their own local `expandedId`; the guard MUST be path-anchored to password-list.tsx.
- **Acceptance criteria**:
  - `layoutMode="accordion"`: clicking a row expands it inline; `activeEntry` set to that row.
  - `layoutMode="master-detail"`: clicking a row renders the pane; no inline expand; same `activeEntry`.
  - Crossing the `lg` breakpoint while an entry is active keeps the SAME `activeEntry` (no loss — the old
    F10/F13 bridge is unnecessary because the primitive is shared).
  - Changing folder clears the pane. Deleting the active entry (single OR bulk) clears the pane.
- **Consumer-flow walkthrough**:
  - Consumer `PasswordList` (path: `src/components/passwords/detail/password-list.tsx`) reads `activeEntryId`
    to mark the active row, calls `onActivate(overviewRow)` on row click (no-op while `selectionMode`), and
    fires `onEntryRemoved(id)` at the single-entry removal sites (INV-C4.3). The inline accordion body renders
    for a row IFF `activeEntryId === entry.id && layoutMode === "accordion"` (F17) — in `master-detail` mode
    NO row renders inline (detail goes to the pane), so the active entry is never decrypted in two places at
    once (preserves INV-C1.1's single-resident guarantee).
  - Consumer `PasswordDashboard` holds `activeEntry` (the full overview row), feeds `activeEntry.id` as
    `key`/`entryId` to `PasswordDetailPane` (C2), builds the personal `getDetail` closure from
    `activeEntry.{entryType,urlHost,requireReprompt,title}` + the fetched raw blob, and clears on
    `onEntryRemoved`. The overview row carries every field the personal closure needs (F11/F14 resolved).
  - Consumer `EntryListShell` (path: `src/components/passwords/detail/entry-list-shell.tsx:95-107`) in
    master-detail + `selectionMode` renders the external checkbox alongside the compact row at the narrow
    pane width; the checkbox placement is specified in C6 (INV-C6.3) so the title stays legible at
    `min-w-[320px]`.

### C5 — Responsive 3-pane layout (personal dashboard)

- **Signature**: `PasswordDashboard` render restructured:
  - `xl:` `flex` row → list region (`xl:w-[380px] shrink-0 overflow-auto`) + detail region (`flex-1 overflow-auto`).
  - `lg:` list + detail (detail as 2nd column at reduced width OR slide-over driven by `activeEntry`).
  - `< lg:` single column, `layoutMode="accordion"`, current `mx-auto max-w-4xl` retained.
  - A new JS breakpoint hook `useLayoutMode()` reads `window.matchMedia("(min-width: 1024px)")` and returns
    `"master-detail" | "accordion"`. This is the SINGLE source of `layoutMode` (T9 — resolves the prior
    CSS-only/JS-seeded contradiction). It is unit-testable by mocking `window.matchMedia`.
- **Invariants**:
  - **INV-C5.1** (app-enforced): list and detail are SEPARATE `overflow-auto` scroll containers in
    master-detail mode (independent scroll; no whole-page reflow on selection).
  - **INV-C5.2** (app-enforced): `max-w-4xl` centering applies ONLY in `< lg` accordion mode; master-detail
    mode is full-bleed within the content area.
  - **INV-C5.3** (app-enforced): `layoutMode` comes from the `useLayoutMode()` `matchMedia` hook — a single
    JS source of truth (not CSS-only, not duplicated per child). The Tailwind responsive classes for visual
    layout MUST agree with the same 1024px breakpoint the hook uses.
  - **INV-C5.4** (app-enforced): crossing the `lg` breakpoint does NOT lose the active entry — because
    `activeEntry` is a single dashboard-owned primitive (C4), the same value simply re-renders inline vs in
    the pane. NO cross-component bridge and NO re-seeding is performed (the F10/F13 bridge is eliminated by
    the C4 unification); the layoutMode change triggers no `getDetail` re-fetch (same `activeEntry.id`,
    same `key`, so the C1 hook does not refire).
  - **INV-C5.6** (app-enforced, commonization — user directive): the 3-pane container is a REUSABLE,
    vault-agnostic component `MasterDetailShell` (props: list slot, detail slot, `layoutMode`, `activeEntryId`)
    — NOT layout logic inlined into `PasswordDashboard`. The personal dashboard mounts it; the team page
    (SC1) mounts the SAME component later by feeding the team list + team `getDetail`. No personal-specific
    branch inside the shell.
  - **INV-C5.5** (app-enforced, SSR/hydration): `useLayoutMode()` MUST be SSR-safe — return `"accordion"`
    during SSR AND the first client render (implement via `useSyncExternalStore` with a server snapshot, or
    a mounted-guard), so server and client first-render agree (no hydration mismatch). The breakpoint-correct
    value lands after mount. This dovetails with "No auto-select on load" (no `activeEntry` exists during the
    one-frame accordion default, so no inline→pane jump). There is no existing `matchMedia`/`useMediaQuery`
    usage in `src/` — this hook is net-new with no precedent to copy (F15).
- **Forbidden patterns**:
  - `pattern: max-w-4xl` appearing on a container that also renders the detail pane — reason: INV-C5.2.
  - **Structural placement guard (S6/S10, supersedes a bare per-file regex)**: `activeEntry`/`detailData`
    `useState` MUST appear in `password-dashboard.tsx` and ONLY there (a positive presence assertion is
    harder to evade than per-file absence). The prohibited move is hoisting that state — OR relocating
    `<VaultGate>` / inserting any provider/wrapper — ABOVE `VaultGate`. Note `dashboard/page.tsx` is a
    client component BELOW the gate (a hoist there is safe but still discouraged); the genuinely dangerous
    target is `dashboard/layout.tsx` (above the gate). A test asserts `<VaultGate>` is an ancestor of the
    detail-state holder (cf. existing vault-gate test patterns).
- **Acceptance criteria** (VC1 manual + Playwright):
  - At ≥1280px: three regions visible, list ~380px, detail fills remainder.
  - At 1024–1280px: list + detail visible (or detail slide-over on select).
  - At <1024px: single-column accordion, identical to today.

### C6 — Compact `PasswordRow` for narrow list pane

- **Signature**: extract a compact row presentation used when `layoutMode="master-detail"`:
  - two-line layout: line 1 = favicon + title + quick-copy; line 2 = username/host + capped tags.
  - chevron dropped (selection replaces expand affordance); overflow `MoreVertical` menu retained.
  - `min-w` floor so the row stays legible (target list pane `min-w-[320px]`, default ~360–400px).
- **Invariants**:
  - **INV-C6.1** (app-enforced): the rich single-line card (current `PasswordCard` row) is retained for
    `accordion` mode; compact row is used only in `master-detail` mode. Both share entry data; neither is
    deleted.
  - **INV-C6.2** (app-enforced): tag badges in the compact row are capped/overflowed (not `shrink-0` in a
    way that crushes the title) — tags move to line 2 with an overflow indicator.
  - **INV-C6.3** (app-enforced): in master-detail + `selectionMode`, the `EntryListShell` external checkbox
    (entry-list-shell.tsx:95-107) sits in line 1 of the compact row (before the favicon) and the title stays
    fully legible at `min-w-[320px]` (the checkbox+gap budget is reserved in the line-1 layout, F5).
  - **INV-C6.4** (app-enforced, anti-drift): the per-entry-type secondary-line renderer (8 branches,
    password-card.tsx:631-685) and the copy-action / overflow-menu cluster are extracted into shared
    sub-components consumed by BOTH the rich card and the compact row — neither row re-implements the
    8-type switch (avoids the parallel-impl drift hazard, F9; cf. project_extension_parallel_impl).
- **Forbidden patterns**:
  - `pattern: shrink-0` on the tag container inside the compact row — reason: INV-C6.2 (tags must yield).
- **Acceptance criteria**:
  - At 320px list-pane width, title remains fully legible; username/host on line 2; tags capped.
  - Selection-mode checkbox (entry-list-shell.tsx:95-107) still renders the title legibly at min width.
  - **Anti-drift parity test (T12/T15, replaces the aspirational "9th type" criterion)**: a unit test renders
    BOTH the rich card and the compact `PasswordRow` for each of the 8 entry types with the SAME entry
    fixture and asserts the two rows' secondary-line text are equal **to each other**
    (`expect(richSecondaryText).toEqual(compactSecondaryText)`), querying via a stable testid/role on the
    secondary line (NOT a whole-subtree snapshot). Independent per-row expected strings do NOT catch drift
    (both could be edited wrong in lockstep); only the same-input cross-comparison does (T15). Divergence
    fails the test today, without a hypothetical 9th type. (The "adding a 9th type edits one renderer"
    sentence remains only as design rationale, not as a testable acceptance criterion.)
- **i18n**: new user-facing strings — `"select an entry"` (C2 empty-state) and `"N selected"` (C4.4) — need
  `messages/en.json` + `messages/ja.json` keys (ja: no カタカナ for vault; follow feedback_ja_vault_translation).

### C7 — Keyboard navigation (list pane)

- **Signature**: list-pane key handler:
  - `↑`/`↓` → move `activeEntry` to prev/next visible entry (master-detail mode only).
  - `Enter` / `Tab` → move focus into the detail pane.
  - `Esc` → return focus to the list (and in slide-over `lg` mode, dismiss the detail overlay).
- **Invariants**:
  - **INV-C7.1** (app-enforced): arrow navigation is active ONLY in `master-detail` mode and does not
    interfere with the existing global shortcuts (`/`, `Cmd/Ctrl+K`, `n`, `?`, `Esc`) in
    password-dashboard.tsx.
  - **INV-C7.2** (app-enforced): arrow nav must not fire while focus is inside a text input (search box) —
    reuse the existing `inInput` computation (password-dashboard.tsx:167-169).
  - **INV-C7.3** (app-enforced): C7's key handler attaches to the list-pane CONTAINER (not `window`), so it
    does not compound the dashboard's existing window-level `Esc` cascade (clear search → exit selection,
    password-dashboard.tsx:178-193). Esc precedence: pane-focused Esc returns focus to the list (and dismisses
    the `lg` slide-over) BEFORE the global cascade runs; the global cascade fires only when the pane is not
    focused (F8).
  - **INV-C7.4** (app-enforced): arrow-nav obeys INV-C4.4 — no `getDetail` decrypt fires while in selection
    mode. Arrow-nav `activeEntry` changes are debounced (~150ms) so holding `↓` does not fire N concurrent
    `getDetail` round-trips; the INV-C1.4 cancel-flag prevents stale renders but not redundant in-flight
    fetches (S8). Each transient decrypt still respects INV-C1.1 (one resident plaintext at a time).
- **Forbidden patterns**: none (interaction logic).
- **Acceptance criteria** (VC4 Playwright):
  - `↓` from selected row N selects N+1 and updates the pane.
  - `Esc` from the detail pane returns focus to the list row.
  - Typing in the search box is not hijacked by arrow nav.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `usePasswordEntryDetail` hook (decrypt lifecycle + security invariants) | locked |
| C2 | `PasswordDetailPane` component (pane + empty state) | locked |
| C3 | `PasswordCard` refactor (behavior-preserving, 4-consumer lockstep) | locked |
| C4 | Unified active-entry model (`activeEntry`) + `PasswordList` props | locked |
| C5 | Responsive 3-pane layout (personal dashboard) | locked |
| C6 | Compact `PasswordRow` for narrow list pane | locked |
| C7 | Keyboard navigation (list pane) | locked |

All 7 contracts `locked` after 4 review rounds (38 findings raised + resolved; R4 convergence-verified all
contracts internally consistent). No Critical/Major findings remain open.

## Testing strategy

- **Unit (vitest, jsdom — no layout engine)**:
  - C1 INV-C1.1 clear-on-switch; INV-C1.4 cancel-flag race using **deferred/controllable promises** (resolve
    the stale A-fetch AFTER selecting B), asserting (a) the stale resolve actually fired (race window opened)
    and (b) the rendered id is the current one. Regression guard: deleting the `cancelled` guard flips the
    test red (T1, RT4/RT5).
  - C1 INV-C1.3 clear-on-lock tested by forcing a `vaultStatus`→non-UNLOCKED **prop/state transition**
    (re-render) — **NO fake timers**; the hook clears on a state transition, not a timer (T2). The
    auto-lock-PRODUCES-the-transition link is already covered by `auto-lock-context.test.tsx` (fake timers)
    + one real-clock manual confirmation (VC3).
  - C1 invalidate() forces re-fetch after edit-onSaved (F2).
  - INV-C1.2 no-hover/prefetch-decrypt: behavioral test — `userEvent.hover` a row, assert `getDetail` NOT
    called (T8), not only the advisory regex.
  - C2 empty-state (entryId=null) and key-reset (reveal A → switch → B masked, mutation-resistant per T6).
  - C4 selection-vs-expand semantics by `layoutMode`; INV-C4.4 selectionMode + master-detail → row click
    fires checkbox toggle, `onActivate` NOT called (T5); INV-C4.2 clear-on-view-change (the during-render
    `viewKey` block, password-dashboard.tsx:139-142); INV-C4.3 clear-on-delete via the upward id signal.
  - C6 `PasswordRow` non-layout behavior: click→`onActivate`, title/username render, overflow-menu present
    (RT6, T4) — a dedicated `password-row.test.tsx`; plus the per-type rich-vs-compact parity test (T12).
  - C5 `useLayoutMode()` hook (T9/T13): the `matchMedia` mock MUST implement a stateful
    `addEventListener`/`removeEventListener("change", …)` with a dispatchable `change`; the test flips the
    breakpoint by mutating `matches` and invoking the stored `change` listener inside `act()` — NOT by a bare
    re-render (a static `vi.fn()` matchMedia never transitions → vacuous pass, T13). The test must FIRST
    assert `layoutMode` actually flipped (precondition) THEN assert crossing the breakpoint keeps the same
    `activeEntry` and fires NO extra `getDetail` (INV-C5.4) — otherwise the call-count assertion is decorative
    (RT4). Also assert INV-C5.5: server/first-render value is `"accordion"`. Requires adding a `matchMedia`
    polyfill (no `matchMedia` exists in `src/` today; `setup.ts` polyfills neither matchMedia nor
    ResizeObserver — ResizeObserver is polyfilled per-test-file — so add matchMedia per-test-file or to a
    shared jsdom setup).
  - C1 INV-C1.6 bfcache: dispatch `pageshow {persisted:true}` with a null restored key, assert the forced
    client LOCK transition fires (the handler-fires part is unit-testable; the real bfcache restore is
    Manual) (T11).
- **Test migration (C3)**: per the C3 test-migration subsection — decrypt mocks move to
  `use-password-entry-detail.test.tsx`; `password-card.test.tsx` keeps prop-based assertions only.
- **Integration (real-DB)**: accordion CRUD/decrypt tests pass for all 4 consumers after test migration
  (C3 no-divergence). Real decrypt round-trip per VC2; personal-path field assembly (requireReprompt etc.)
  verified. MUST exercise the **3-pane personal pane** decrypt explicitly (not only the accordion) so the
  F11 data-ownership gap cannot pass green (R16 / project_integration_test_gap).
- **E2E (Playwright)**: C5 region visibility via `page.setViewportSize` within the Desktop Chrome project at
  **1280 (3-pane), 1100 (list+detail), 1023 (accordion)** — pins both breakpoint edges (T7); C6 compact-row
  legibility at 320px; C7 keyboard traversal (↓ moves selection, Esc returns focus) (VC4).
- **C7 debounce coalescing (unit, S12)**: repeating `↓` across N rows within the ~150ms window fires
  `getDetail` FEWER than N times (assert call-count < keypresses) — so deleting the debounce flips the test
  red (INV-C1.4's cancel-flag alone would still make the final render correct, making a final-id-only test
  decorative).
- **Manual (per VC list)**: VC1 breakpoint resize incl. crossing-`lg`-while-active (INV-C5.4); VC2 real
  unlock+decrypt; VC3 real-clock auto-lock clear (single confirmation); bfcache Back/Forward restore shows
  the lock screen, not decrypted state (INV-C1.6 — real bfcache not reproducible in jsdom/Playwright, T11).
- **Regression guard (operationalized, T6)**: each clear test follows positive-precondition → trigger →
  assert-null (INV-C1.1/.3, INV-C4.2/.3, INV-C2.1). Removing the final assertion leaves an unconsumed
  precondition, so the test cannot pass tautologically (a test that still passes with the assertion removed
  is decorative).

## Considerations & constraints

### Scope contract
- **SC1** — Team page / team-archived list / emergency-access vault 3-pane **layout wiring** is out of scope
  for THIS PR — but per the commonization directive, the shared `MasterDetailShell` + C1/C2/C6 are built
  vault-agnostic so SC1 is a WIRING task (feed team list + team `getDetail` into the same shell), NOT a
  parallel build. These consumers keep the accordion in this PR but already consume the shared extracted code
  (clear-on-lock fix + commonized per-type rendering). Owned by `feature/three-pane-team-emergency`.
- **SC2** — Deep-linking `selectedId` via URL searchParam is out of scope (security: entry-id browser-history
  metadata leak; UX deferred). `selectedId` is client React state only. Owned by a future issue.
- **SC3** — Edit-in-place within the detail pane is out of scope; edit remains the existing modal dialog
  (`PasswordEditDialogLoader`). The "modal covers both panes" UX friction is accepted for this PR and tracked
  for a future PR (`feature/detail-pane-inline-edit`).
- **SC4** — Clear-on-hide (clearing `detailData` on `visibilitychange→hidden` so a backgrounded tab holds no
  plaintext before auto-lock fires) is out of scope. **Anti-Deferral justification (S9)**:
  - Worst case: one entry's plaintext resident in JS heap for ≤5 min (auto-lock hidden timeout,
    auto-lock-context.tsx:8-9,34) while the tab is backgrounded on an already-unlocked device.
  - Likelihood: low — exploitation requires a pre-existing local compromise (malicious in-page extension or
    memory forensics) that could already read the vault key directly; the bound only matters for the narrow
    window between tab-hide and auto-lock.
  - Cost to fix now: near-zero (~5 lines hanging off the EXISTING `visibilitychange` listener at
    auto-lock-context.tsx:87). Deferred ONLY to keep this PR's scope to the layout change; if the bound is
    later judged insufficient it is a trivial follow-up. `TODO(three-pane-vault-layout): clear-on-hide`.

### Known risks
- **R-risk-1**: `PasswordCard` is ~970 lines and instantiated by 4 consumers; the C3 extraction is the
  riskiest step. Divergence is structurally prevented by INV-C1.7/INV-C3.1 (hook does zero field-mapping;
  each consumer's `getDetail` returns a complete `InlineDetailData`). Mitigation: run all 4 consumers'
  integration tests in lockstep after the test migration (INV-C3.2, T3).
- **R-risk-2**: persistent pane extends decrypted-plaintext lifetime vs accordion. Mitigation: INV-C1.1 (one
  resident at a time), INV-C1.3 + INV-C1.5 (VaultGate unmount is primary clear; pane stays in the UNLOCKED
  subtree), C4 clear-on-view-change/delete, C2 key-by-id. **Accepted bound**: while a tab is backgrounded,
  one entry's plaintext stays resident until the auto-lock hidden timeout fires (default ≤5 min,
  auto-lock-context.tsx:8-9) — strictly the persistent-pane tradeoff; clear-on-hide deferred (SC4). bfcache
  restore re-display is closed by INV-C1.6 (`pageshow` re-check).
- **R-risk-3**: row-click overload (open-detail vs multi-select-toggle vs expand) — INV-C4.1/.4 disambiguate
  by `layoutMode` × `selectionMode`.

## Implementation Checklist (Step 2-1)

### Reusable inventory (MUST reuse — do not reimplement)
- `useVault()` (vault-context.tsx:1308) — personal key/`vaultStatus`/`lock()`. `useTeamVault()`
  (team-vault-core.tsx:71) — team key access. `VaultStatus` / `VAULT_STATUS` (vault-context.tsx:91).
- `lock()` (vault-context.tsx:248-265) — call for INV-C1.6 forced lock (NOT bare setVaultStatus).
- `useReprompt` (use-reprompt.ts), `useRevealTimeout`/`useRevealSet` (use-reveal-timeout.ts) — keep INSIDE
  `key={activeEntry.id}` boundary (INV-C2.3). Existing `eslint-disable` at use-reprompt.ts:79 migrates WITH
  its documented reason (RS2).
- `buildPersonalEntryAAD` / `buildTeamEntryAAD` — stay inside each vault's `getDetail` closure (INV-C1.7); no
  AAD re-derivation in the shared hook (project_aad_distributed_contract_rootcause).
- `fetchDecryptedEntry` logic (password-card.tsx:251-411) — moves into the personal `getDetail` closure
  verbatim (incl. `aadVersion>=1 && userId` gate); do NOT re-derive.
- `DisplayEntry` (password-list.tsx) — reuse as the `activeEntry` row type (F19); no parallel `EntryOverview`.
- `VaultGate` (vault-gate.tsx) — pane MUST stay a descendant (INV-C1.5).
- `EntryListShell` (entry-list-shell.tsx) — external-checkbox selection-mode wrapper; reuse, don't fork.

### Files to create
- `src/hooks/vault/use-password-entry-detail.ts` (C1) + `.test.tsx`
- `src/hooks/use-layout-mode.ts` (C5, useSyncExternalStore+matchMedia, SSR-safe) + `.test.tsx`
- `src/components/passwords/detail/password-detail-pane.tsx` (C2) + `.test.tsx`
- `src/components/passwords/detail/password-row.tsx` (C6 compact) + `.test.tsx`
- `src/components/passwords/detail/master-detail-shell.tsx` (C5, vault-agnostic reusable, INV-C5.6) + `.test.tsx`
- shared per-entry-type secondary-line renderer + copy/menu cluster sub-components (C6/INV-C6.4)
- `src/__tests__/setup.ts` (or per-test-file): add `matchMedia` polyfill (T13)

### Files to modify
- `password-card.tsx` (C3) — replace `expanded &&` block with C1 hook + shared pane body; PUBLIC PROPS
  UNCHANGED (`expanded`/`onToggleExpand`); use shared per-type renderer (INV-C6.4); call `invalidate()` at
  :909/:928 instead of `setDetailData(null)`.
- `password-list.tsx` (C4) — remove `expandedId`; add `activeEntryId`/`onActivate`/`onEntryRemoved`/
  `layoutMode`; map internally to PasswordCard `expanded`/`onToggleExpand`; fire `onEntryRemoved(id)` at
  :256/:282/:297; bulk membership-check→`onActivate(null)` after `fetchPasswords()` (INV-C4.3).
- `password-dashboard.tsx` (C4/C5) — own `activeEntry` (DisplayEntry|null); `useLayoutMode()`; mount
  `MasterDetailShell` with list + `PasswordDetailPane key={activeEntry?.id}`; clear `activeEntry` in the
  during-render `viewKey` block (INV-C4.2) + on `onEntryRemoved` (INV-C4.3); keyboard nav (C7).
- `messages/en.json` + `messages/ja.json` — "select an entry" / "N selected" (ja: 保管庫 vocabulary, no カタカナ).
- bfcache `pageshow` handler (INV-C1.6) — likely in vault-context.tsx alongside the `pagehide` handler.

### Patterns to follow consistently
- Commonization (user directive): every new component vault-agnostic; team/emergency consume the same C1/C2/
  C6 code; `MasterDetailShell` reusable (INV-C5.6). The 3 SC1 consumers keep their own `expandedId` (path-
  scoped forbidden pattern, F18) and are UNTOUCHED except adopting the shared hook/pane/renderer.
- All clear-behavior tests: positive-precondition → trigger → assert-null (T6, non-decorative).

### CI gate parity (Step 2-1 diff)
Local `scripts/pre-pr.sh` present (the aggregate). CI gates include: `check-state-mutation-centralization`,
`refactor-phase-verify`, `check:bypass-rls`, `check:crypto-domains`, `check:env-docs`, `check:migration-drift`,
`check:team-auth-rls`, `licenses:check:*:strict`, `lint`, (+ test/build/e2e). Disposition: run
`scripts/pre-pr.sh` in Step 2-4 (it bundles these) + `extract-ci-checks.sh` loop. No parity gap recorded yet;
`check:team-auth-rls` / `check:crypto-domains` are relevant given team-path commonization — re-verify in 2-4.
Per project_ci_gates_beyond_pre_pr: Extension + DB+Redis integration jobs are NOT in pre-pr.sh — but this PR
touches neither extension nor DB, so those jobs are N/A here.

## User operation scenarios

1. **Browse + inspect (xl)**: unlock vault → list shows compact rows → click "GitHub" → pane shows detail →
   click "AWS" → pane swaps to AWS, GitHub plaintext cleared (INV-C1.1).
2. **Auto-lock while pane open (VC3)**: select an entry → leave idle past auto-lock window → pane clears,
   no plaintext on screen (INV-C1.3).
3. **Folder switch**: select an entry → click a different folder in sidebar → pane resets to empty-state
   (INV-C4.2).
4. **Delete selected**: select an entry → delete it from the row menu → pane resets to empty-state (INV-C4.3).
5. **Bulk select**: enter selection mode → click rows → checkboxes toggle, pane shows "N selected", no single
   detail decrypt (INV-C4.4).
6. **Keyboard (VC4)**: `/` focuses search → type → `Esc` → `↓`/`↓` moves selection → `Enter` into pane →
   `Esc` back to list.
7. **Narrow window (`< lg`)**: shrink window below 1024px → layout falls back to single-column accordion,
   click expands inline exactly as today (INV-C6.1).
8. **Tablet (`lg`)**: at ~1100px → list + detail; selecting an entry reveals the detail column/slide-over.
