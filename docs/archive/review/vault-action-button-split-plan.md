# Plan: Three-pane vault — list/detail action-button split

## Project context

- **Type**: web app (Next.js App Router, client-side E2E-encrypted vault UI)
- **Test infrastructure**: unit + integration (vitest) + CI. UI component tests exist
  for every file touched here (`password-row.test.tsx`, `entry-list-view.test.tsx`,
  `password-detail-pane.test.tsx`, `password-detail-inline.test.tsx`,
  `password-card.test.tsx`).
- **Verification environment constraints**: none relevant. This change is pure
  presentation/interaction reorganization in client components — no crypto, DB,
  auth, network, or paid-tier surface. All paths are `verifiable-local` via vitest
  + manual dev-server inspection. No `blocked-deferred` paths.

## Objective

Reorganize the action buttons in the three-pane (master-detail) vault layout so that
the **list pane is a pure copy/select accelerator** and the **detail pane is the single
home for manage actions**. This removes the current role inversion where the list
row's `⋮` menu is *more* capable (Edit/Share/Archive/Delete) than the detail header's
`⋮`, contradicting the code's own stated intent ("the list row's ⋮ is a pure mouse
accelerator", `password-detail-pane.tsx:68-71`).

User-confirmed direction:
1. **List row `⋮`** → copy actions only. Move Edit / Share / Archive / Delete /
   Restore / Delete-permanently out of the row, into the detail pane.
2. **Detail header** → promote **Edit** to a visible button. Keep favorite star
   visible + `⋮` for secondary manage actions (Share / Archive / Delete / Restore /
   Delete-permanently).
3. Reconcile menu contents so list and detail are consistent under the new role split.

## Requirements

### Functional
- The 3-pane list row keeps: row-click → select, favorite star, quick-copy button,
  and a `⋮` containing copy-only items (per entry type).
- The 3-pane list row no longer surfaces Edit / Share / Archive / Delete / Restore /
  Delete-permanently anywhere on the row.
- The detail pane header shows a visible **Edit** button (gated by edit permission),
  the favorite star, and a `⋮` with Share / Archive / Delete (+ Restore /
  Delete-permanently in trash).
- Edit must not appear twice in the 3-pane (header owns it; the body-footer Edit is
  suppressed in 3-pane only).
- Attachment/history editability inside the detail body must be unchanged in 3-pane
  (it is currently keyed on `onEdit` presence — that signal must be preserved).

### Non-functional
- **No behavior change for the legacy accordion** (`PasswordCard`, used by the team
  accordion layout and the emergency-access read-only vault). `EntryActionsMenu` is
  shared between `PasswordRow` (3-pane) and `PasswordCard` (accordion); the slim
  variant must be opt-in so the accordion keeps its full menu and body-footer Edit.
- Commonization preserved — one `EntryActionsMenu`, no duplicated copy/menu logic
  (project value; see CLAUDE.md and `feedback_commonize_personal_team_ui_logic`).
- No dead props left forwarded (project no-dead-code rule).

## Technical approach

Surface-aware variation on the existing shared component plus a visible-button
promotion in the detail pane. Four small, independent contracts.

**Key wiring facts confirmed during planning:**
- `entry-list-view.tsx:586-590` already passes `onEdit` to `PasswordDetailPane`
  (currently consumed only by the body). Promoting Edit to the header needs **no new
  wiring in `entry-list-view`** — only a header button in `PasswordDetailPane` reading
  the existing `onEdit`.
- `entry-list-view.tsx:605-630` already passes `onShare/onArchive/onDelete/onRestore/
  onDeletePermanently` to the detail header `⋮` — detail side is already complete.
- `PasswordDetailInline` (body) is shared by both `PasswordDetailPane` (3-pane) and
  `PasswordCard` (accordion). Its `onEdit` doubles as the attachment-editable signal
  (`AttachmentSection readOnly={!onEdit}`, `password-detail-inline.tsx:123,129`), so
  `onEdit` MUST keep flowing to the body; only the body-footer Edit *button* is
  suppressed in 3-pane.
- i18n: `PasswordCard.edit` = "Edit" already exists (EN+JA). `PasswordDetailPane`
  already binds `tc = useTranslations("PasswordCard")`. No new i18n keys required.

---

## Contracts

### C1 — `EntryActionsMenu` gains a `variant` prop

**File**: `src/components/passwords/detail/entry-actions-menu.tsx`

**Signature delta** (props):
```
variant?: "full" | "accelerator"   // default "full"
// Manage-action callbacks + capability flags become optional (only used by "full"):
onShare?, onEdit?, onToggleArchive?, onDeleteRequest?, onRestore?, onDeletePermanently?
canEdit?, canDelete?, canShare?    // were required; now optional
```

**Behavior**:
- `variant === "full"` (default): **byte-for-byte the current render** — quick-copy +
  copy items + Share + Edit + Archive/Unarchive + Delete + Restore +
  Delete-permanently, gated by the existing `canEdit/canDelete/canShare` flags. The
  accordion is unaffected.
- `variant === "accelerator"`: render the quick-copy `CopyButton` + the `⋮` containing
  **only the per-type copy `DropdownMenuItem`s** (the block currently at lines 154-228:
  copyAccountNumber / copyLicenseKey / copyUsername+copyCredentialId / copyIdNumber /
  copyCardNumber+copyCvv / copyFingerprint+copyPublicKey / copyContent /
  copyUsername+copyPassword). The Share / Edit / Archive / Delete / Restore /
  Delete-permanently blocks (lines 229-294) and their separators are NOT rendered.
- **DEC-1 (Open URL)** — see Considerations. Default decision encoded here: in
  `accelerator` mode, the `openUrl` item **is retained** (it is a per-row "use"
  accelerator, not a manage action, and has no other home on the row). If the user
  overrides DEC-1 to "copy-strictly-only", drop the `openUrl` item too.

**Invariants** (app-enforced):
- INV-C1.1: `variant` defaulting to `"full"` ⇒ every existing caller that omits it
  (i.e. `PasswordCard`) renders the unchanged full menu.
- INV-C1.2: `accelerator` mode renders zero manage items even if a manage callback is
  passed (defense against accidental forwarding).
- INV-C1.3 (full-variant gate unchanged — review F2): making `canEdit/canDelete/
  canShare` optional must NOT introduce a `= true`/`= false` default that changes the
  `full` branch's gating semantics. `PasswordCard` always passes the real flags
  (`password-card.tsx:584-644`), so the full branch must keep reading the passed value;
  any added default is purely to satisfy the optional type and must never be hit by a
  current caller.

**Forbidden patterns** (must NOT appear in the diff):
- `pattern: variant === "accelerator"[\s\S]*?onSelect=\{onDeleteRequest\}` — reason:
  accelerator menu must never wire the destructive Delete item.
- `pattern: variant === "accelerator"[\s\S]*?onSelect=\{onShare\}` — reason: Share is a
  manage action, detail-only.

**Acceptance**:
- `PasswordCard` (no `variant`) menu unchanged — `password-card.test.tsx` passes
  without edits.
- In `accelerator` mode the rendered `⋮` contains only copy items (+ openUrl per
  DEC-1) and no Edit/Share/Archive/Delete/Restore/Delete-permanently items.

**Consumer-flow walkthrough** (this is a component-prop contract, not a data shape, but
listing consumers per Step 1-2):
- Consumer `PasswordCard` (path: `password-card.tsx:579`) reads the menu with no
  `variant` → `"full"`; uses every manage callback exactly as today.
- Consumer `PasswordRow` (path: `password-row.tsx:262`) passes `variant="accelerator"`
  and (per C2) stops forwarding manage callbacks; uses only copy fetchers/handlers
  (+ `onOpenUrl` per DEC-1).

---

### C2 — `PasswordRow` uses the accelerator variant; drops manage props

**File**: `src/components/passwords/detail/password-row.tsx`
(+ caller `entry-list-view.tsx:708-745`, test `password-row.test.tsx`)

**Behavior**:
- `PasswordRow` passes `variant="accelerator"` to `EntryActionsMenu`.
- Remove the now-dead manage props from `PasswordRowProps` and stop forwarding them:
  `onShare`, `onEdit`, `onToggleArchive`, `onDeleteRequest`, `onRestore`,
  `onDeletePermanently`, `canEdit`, `canDelete`, `canShare`.
- **Keep**: `showFavorite` + `onToggleFavorite` (the star stays on the row), all copy
  fetchers (`fetchPassword`/`fetchCardField`/…) and copy handlers
  (`onCopyUsername`/`onCopyPassword`/…), and `onOpenUrl` (per DEC-1).
- In `entry-list-view.tsx`, delete the corresponding props from the `<PasswordRow>`
  render (lines 722-744): `onShare`, `onEdit`, `onToggleArchive`, `onDeleteRequest`,
  `canEdit`, `canDelete`, `canShare`, `onRestore`, `onDeletePermanently`. The detail
  pane (lines 579-631) already owns all of these — **no behavior is lost**, only the
  row duplicate.

**Invariants** (app-enforced):
- INV-C2.1: After this change the row renders no destructive affordance; deletion is
  only reachable from the detail pane.
- INV-C2.2: `handleSoftDelete` / `handleShare` / `handleSetArchived` /
  `handleRestore` / `setDeletePermanentlyPending` remain wired to the detail pane
  (unchanged) — removing the row props must not remove these handlers.

**Forbidden patterns**:
- `pattern: onDeleteRequest=` in `password-row.tsx` — reason: the row must not carry
  the delete affordance after the split.

**Acceptance**:
- `password-row.test.tsx`: **delete the entire "C9 — PasswordRow trash affordances"
  describe-block (`:389-518`)** — it asserts the row `⋮` renders `delete` (`:411,:517`),
  `restore`, and `deletePermanently`, all of which leave the row under this split
  (review T1). Relocate the Restore / Delete-permanently *behavior* coverage to the
  detail pane (see C3/C5 testing).
- `password-row.test.tsx`: add **one paired presence+absence test that OPENS the row
  `⋮` first** (Radix `DropdownMenuContent` is unmounted while closed, so an absence
  assertion on a closed menu passes vacuously — review T2/T3, and the user's
  phantom-match guidance). Concretely: `await user.click(getByText("moreActions"))`,
  then assert a copy item is present (e.g. `copyPassword` for login — proves the menu
  opened) AND `queryByText("edit"|"share"|"archive"|"delete")` are all absent.
- `entry-list-view.test.tsx`: (optional, review T7) add a captured-props assertion that
  the rendered `PasswordRow` no longer receives `onDeleteRequest`/`onEdit`/`onShare`
  (mirrors the existing `capturedCardProps` pattern) to guard INV-C2.1 at the wiring
  level. The `npx next build` type check already catches the unused-prop removal.
- `npx next build` clean (no unused-prop / type errors).

---

### C3 — `PasswordDetailPane` header gets a visible Edit button

**File**: `src/components/passwords/detail/password-detail-pane.tsx`

**Behavior**:
- In the persistent-action cluster (`div` at lines 168-234), add a visible **Edit**
  button, gated by the existing `onEdit` prop (already received, lines 64/586-590).
- Placement: leftmost of the cluster (Edit → Star → `⋮`), or Star → Edit → `⋮`;
  pick the order that reads best (recommend **Edit · Star · ⋮** so the primary verb
  leads). Style: `variant="ghost" size="icon"` icon-button with `sr-only` label, OR a
  compact labeled `variant="outline" size="sm"` button (recommend icon-button to match
  the star/⋮ cluster density). Label via `tc("edit")` (PasswordCard namespace, already
  bound).
- **Accessible name is MANDATORY (review S5-A)**: if the icon-button variant is used,
  it MUST carry an accessible name — `<span className="sr-only">{tc("edit")}</span>`
  inside the button (mirroring the `⋮` trigger at `password-detail-pane.tsx:185`) or
  `aria-label={tc("edit")}`. An icon-only Edit with no name is an a11y regression on a
  state-changing flow; this is the same `sr-only` pattern the sibling star and `⋮`
  already honor.
- The `⋮` block (Share/Archive/Delete/Restore/Delete-permanently) is unchanged.

**Invariants** (app-enforced):
- INV-C3.1: Edit button renders iff `onEdit` is provided (same gate the body Edit
  used) — no Edit button in read-only emergency vault paths that pass no `onEdit`.
  (Note: emergency vault uses `PasswordCard`, not `PasswordDetailPane`, so this pane's
  Edit never shows there regardless — INV is belt-and-suspenders.)
- INV-C3.2 (review S4): `onEdit` reaching this pane must remain sourced solely from
  `entry-list-view.tsx:587` (`descriptor.rowActions.edit && adapter.permissions.canEdit`).
  Do not add any code path that supplies `onEdit` independent of that gate — the
  attachment-edit signal (C4) shares this source.

**Forbidden patterns**: none specific.

**Acceptance**:
- `password-detail-pane.test.tsx`: add tests that (a) the header renders an Edit
  control when `onEdit` is provided and clicking it calls `onEdit` once; (b) it is
  **absent** when `onEdit` is undefined. Query by **exact** accessible name
  (`getByRole("button", { name: "edit" })` under the verbatim-key next-intl mock) —
  NOT a positional `getAllByRole("button")[n]`, which is fragile against the
  Edit·Star·⋮ cluster (review T4).

---

### C4 — Suppress the duplicate body-footer Edit in 3-pane

**File**: `src/components/passwords/detail/password-detail-inline.tsx`
(+ caller `password-detail-pane.tsx:277-283`)

**Behavior**:
- Add `showEditButton?: boolean` (default `true`) to `PasswordDetailInlineProps`.
- The body-footer Edit button (lines 146-151) renders iff `onEdit && showEditButton`.
- `PasswordDetailPane` passes `showEditButton={false}` (header owns Edit) **while still
  passing `onEdit`** so attachment/history editability (`readOnly={!onEdit}`) is
  preserved in 3-pane.
- `PasswordCard` (accordion) does not pass `showEditButton` → default `true` → body
  Edit stays in the accordion (unchanged).

**Invariants** (app-enforced):
- INV-C4.1: In 3-pane, exactly one Edit affordance exists (header). In the accordion,
  exactly one Edit affordance exists (body footer).
- INV-C4.2: Attachment & history sections remain editable in 3-pane (i.e. `onEdit`
  still flows to the body; only the button is hidden).

**Forbidden patterns**:
- `pattern: showEditButton={true}` passed from `PasswordDetailPane` — reason: the pane
  must suppress (false), not enable, the body Edit.

**Acceptance**:
- `password-detail-inline.test.tsx`: with `showEditButton={false}` + `onEdit` set, the
  body-footer Edit button is absent but the attachment section is NOT read-only. The
  current `AttachmentSection` mock (`:12-14`) is a bare stub that does not surface its
  `readOnly` prop, so this is **currently unobservable** — upgrade the mock to expose
  it: `AttachmentSection: ({ readOnly }) => <div data-testid="attachment-section"
  data-readonly={String(!!readOnly)} />`, then assert `data-readonly="false"` (review
  T6). Add the default-true regression too (`onEdit` set, no `showEditButton` →
  footer Edit present) to keep the accordion path green.
- `password-card.test.tsx`: accordion body Edit still present (no `showEditButton`
  passed) — green without edits.

---

### C5 — Detail pane is the sole home for manage actions (test relocation)

**File**: `src/components/passwords/detail/password-detail-pane.test.tsx` (test-only;
no production change — this contract captures the coverage that moves off the row in C2)

**Behavior** (review T1/T5): the manage-action coverage deleted from the row's C9 suite
is relocated here so that after the split there is still a unit assertion that Delete /
Restore / Delete-permanently are reachable — from the detail pane only.

**Acceptance**:
- A test opens the pane header `⋮` (`getByRole("button", { name: "moreActions" })`) and
  asserts `share` + `delete` render and fire their handlers (normal view).
- A trash-view test (handlers `onRestore` + `onDeletePermanently` provided) asserts
  `restore` + `deletePermanently` render and fire.
- These open the menu before asserting (same Radix-mount caveat as C2 / review T3).

---

## Go/No-Go Gate

| ID | Subject                                                        | Status |
|----|---------------------------------------------------------------|--------|
| C1 | `EntryActionsMenu` `variant: "full" \| "accelerator"`          | locked |
| C2 | `PasswordRow` accelerator variant + drop dead manage props     | locked |
| C3 | `PasswordDetailPane` header visible Edit button                | locked |
| C4 | Suppress body-footer Edit in 3-pane (`showEditButton`)         | locked |
| C5 | Detail-pane manage-action test relocation (row → pane)         | locked |

(DEC-1 is a user decision recorded below, not a contract blocker — the default is
encoded in C1; flipping it is a one-line removal of the `openUrl` item in accelerator
mode.)

## Testing strategy

- Unit (vitest) per acceptance criteria above: `entry-actions-menu` variant render,
  `password-row` absence-of-manage assertions, `password-detail-pane` header Edit,
  `password-detail-inline` `showEditButton` suppression + attachment editability,
  `password-card` regression (must stay green untouched).
- Mandatory project gates before "done": `npx vitest run` and `npx next build`
  (per CLAUDE.md). Build catches unused-prop/type fallout from C2's prop removal.
- Manual dev-server check: 3-pane row shows only star + copy + copy-only `⋮`; detail
  header shows Edit + star + manage `⋮`; Edit appears once; delete reachable only from
  detail; team accordion + emergency vault unchanged.

## Considerations & constraints

### F1 — Degenerate single-item `⋮` for some entry types (pre-existing; optional follow-up)
For BANK_ACCOUNT / IDENTITY / SOFTWARE_LICENSE the accelerator `⋮` contains a single
copy item identical to the visible quick-copy button (`entry-actions-menu.tsx:135/137/138`
vs `:155/160/178`). This redundancy already exists in the current `full` variant — this
plan does not introduce it and does not change copy-item rendering. Optional follow-up
(out of scope here): suppress the `⋮` entirely when it would hold only the single item
the quick-copy button already covers. Tracked as a UX-polish note, not a blocker.

### Variant selection is by component identity, not `layoutMode` (review T8)
The `accelerator`/`full` choice is made by which component renders the menu
(`PasswordRow` → accelerator, `PasswordCard` → full). It does NOT read `useLayoutMode`.
Tests therefore distinguish the variants by file (`password-row.test.tsx` vs
`password-card.test.tsx`); no `useLayoutMode` mock is needed for the variant. Stated
here so no redundant layout-mode test is added.

### DEC-1 — Open URL in the accelerator row menu (user decision)
- **Question**: the row `⋮` currently has an "Open URL" item for login entries. It is
  navigation, not copy. User instruction was "copy-only".
- **Recommendation (encoded as default in C1)**: **keep Open URL** in the accelerator
  menu. Rationale: it is a per-row "use" accelerator in the same family as quick-copy
  (one-click access to the most common entry type), it does not duplicate a manage
  action, and removing it has no equivalent one-click home on the row (the URL only
  reappears in the detail body). Strict "copy-only" would remove it.
- **Cost to flip**: ~1 line (remove the `openUrl` `DropdownMenuItem` from the
  accelerator path). Awaiting user confirmation; default ships Open URL retained.

### Scope contract (out of scope for this PR)
- `SC1` — Visual restyling of the detail field rows (the eye+copy density on IDENTITY
  fields noted during the UX review). Tracked separately; not part of the button-split.
- `SC2` — Any change to the legacy `PasswordCard` accordion menu/behavior. Explicitly
  unchanged (full variant is the default). Owned by the accordion's own lifecycle.
- `SC3` — Trash 3-pane and single-list structural unification
  (`project_three_pane_followup`). Separate follow-up PR.

### Constraints
- This work lands on the in-flight branch `feature/three-pane-vault-layout`. Per user:
  **plan only this session** — no implementation, no new branch, no commit of code.
- The plan file itself is written under `docs/archive/review/` (not committed unless
  the user asks).

## User operation scenarios

1. **Quick copy from the list** — user hovers a login row, clicks the quick-copy
   button (password) or opens the copy-only `⋮` to copy username; never accidentally
   hits Edit/Delete because they are gone from the row.
2. **Edit from detail** — user selects an entry; the detail header shows a clearly
   visible Edit button (no longer buried in the body footer or a `⋮`); clicking opens
   the edit form. Edit appears exactly once.
3. **Delete from detail** — user opens the detail header `⋮` → Delete (with confirm).
   The list row offers no destructive action, reducing mis-click risk in the dense
   list.
4. **Trash view** — selected trashed entry: detail header `⋮` offers Restore +
   Delete-permanently; list row offers copy-only `⋮`. (Row no longer has Restore/
   Delete-permanently.)
5. **Team accordion / emergency vault** — unchanged: full `⋮` and body-footer Edit
   exactly as before (regression guard).
