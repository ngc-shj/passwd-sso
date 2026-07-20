# Plan: Fix entry edit dialog horizontal scrollbar from long attachment filenames

## Project context

- **Type**: web app (Next.js 16 App Router + React + Tailwind 4.1 + shadcn/ui)
- **Test infrastructure**: unit + integration (vitest) + E2E (Playwright) + CI/CD
- **Verification environment constraints**: none blocking. CSS-only fix in one shared
  shell component; visually verifiable in local dev (`npm run dev -- -p 3001`). No
  paid-tier APIs, external services, or hardware paths involved.

## Objective

When an attachment with a long, unbroken filename (e.g. a 200-char name, or a long
hex/base64 token with no whitespace) is present in a password entry, opening the
**entry edit dialog** produces a horizontal scrollbar across the whole dialog. The
filename `<p>` already carries `truncate`, so the intended behavior (single-line
ellipsis) is defined but never engages. The dialog stretches to the filename's
intrinsic width instead. Fix so the attachment row truncates within the dialog bounds
— once, in the shared entry-dialog shell that both personal and team edit dialogs use.

This is a distinct instance from the already-fixed delete-confirmation overflow
(`docs/archive/review/fix-attachment-delete-dialog-overflow-plan.md`): that one *wraps*
a filename in an `AlertDialog` description via `wrap-anywhere`; this one needs the
existing `truncate` in the edit dialog's attachment *list* to actually engage.

## Root cause

The filename node already has the correct truncation classes:

- Personal: `src/components/passwords/entry/attachment-section.tsx:407-408`
  — `<div className="flex-1 min-w-0"><p className="text-sm truncate">{att.filename}</p>`
- Team: `src/components/team/forms/team-attachment-section.tsx:301-302` — identical.

`truncate` (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`) requires
every ancestor between the flex/grid container and the text node to be allowed to shrink
below its content width. The chain breaks higher up:

1. `DialogContent` (`src/components/ui/dialog.tsx:70`) is a **CSS grid** (`grid ...
   max-w-[calc(100%-2rem)] ... sm:max-w-lg`; `EntryDialogShell` overrides width to
   `sm:max-w-2xl`, `entry-dialog-shell.tsx:27`).
2. Its direct children are grid items. Grid (and flex) items default to
   `min-width: auto`, which means "do not shrink below the content's intrinsic min
   size." A long unbroken filename gives that subtree a large intrinsic min-width.
3. The attachment section is mounted inside a wrapper `<div className="border-t pt-4
   mt-2">` (`src/components/passwords/dialogs/personal-password-edit-dialog.tsx:271`;
   eight team-form equivalents) which is itself a grid item with **no `min-w-0`**. That
   wrapper refuses to shrink, so the
   grid track expands to the filename width and the whole dialog overflows — the inner
   `truncate` never gets a constrained width to truncate against.

So the bug is not a missing `truncate`; it is a missing `min-w-0` on the grid-item
layer directly under the `DialogContent` grid.

## Technical approach

Add `min-w-0` to every direct child of the `DialogContent` grid **within the shared
entry-dialog shell only**, via the arbitrary-variant class `[&>*]:min-w-0` on the
`DialogContent` in `EntryDialogShell`. This lets any grid-item child (the form, the
attachment-section wrapper, headers) shrink below its intrinsic content width, so the
already-present `truncate` on the filename engages and the dialog honours its `max-w`.

Why this approach:

- **Single shared point, correct blast radius.** `EntryDialogShell`
  (`src/components/passwords/entry/entry-dialog-shell.tsx`) is the one file both the
  personal shell and the team shell re-export. Fixing there covers personal AND team
  edit dialogs and every current/future entry type (login, secure-note, passkey,
  identity, bank-account, ssh-key, credit-card, software-license) without editing the
  nine individual wrapper `<div>`s at each call site. Per-call-site `min-w-0` would
  leave the bug latent in the next form someone adds — the same R8 inconsistency the
  delete-dialog review flagged.
- **Not global `DialogContent`.** Adding `min-w-0` to the shared `DialogContent`
  primitive (`ui/dialog.tsx`) would change grid-item shrink behavior for *every* dialog
  in the app (confirmations, settings, pickers). That is a larger blast radius than the
  reported bug warrants and risks regressing dialogs that rely on the default
  `min-width: auto`. Scope the fix to the entry-dialog shell.
- **`[&>*]:min-w-0` vs `min-w-0` on the content box itself.** The overflow comes from a
  grid *track* sized by its *item's* min-width, so the `min-w-0` must land on the grid
  *items* (the `> *` children), not only on the grid container. `[&>*]:min-w-0` targets
  exactly those direct children. (Adding `min-w-0` to the `DialogContent` box too is
  harmless but not what unblocks the truncate; the item-level rule is the load-bearing
  one.)
- **`truncate`, not `wrap-anywhere`.** A list row should stay single-line with an
  ellipsis (the design already chose `truncate`). Wrapping a long filename across many
  lines in an edit-form list would be worse UX and inconsistent with the existing
  intent. We make the existing `truncate` work rather than change the truncation style.
  (The delete *dialog* wraps because a confirmation sentence reads better wrapped than
  ellipsised — a different context, already handled by its own fix.)

`min-w-0` and arbitrary-variant `[&>*]:` are core Tailwind, no config change.

## Contracts

### C1 — `EntryDialogShell`'s `DialogContent` lets grid-item children shrink

**File**: `src/components/passwords/entry/entry-dialog-shell.tsx:27`

**Signature (JSX className change only)**:

```
- <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
+ <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto [&>*]:min-w-0">
```

**Invariants** (app/CSS-enforced — this is a presentational component with no schema layer):
- I1: Every direct child of the entry `DialogContent` grid has `min-width: 0`, so a
  descendant with `truncate` truncates instead of forcing the grid track wider than
  the dialog's `max-w`.
- I2: No change to dialog width, max-height, vertical scroll, header, or any child
  component's markup. The only observable change is that over-wide unbroken content
  now truncates/clips within bounds instead of introducing a horizontal scrollbar.
- I3: The existing `truncate` + `min-w-0` on the attachment filename node
  (attachment-section.tsx:407-408, team-attachment-section.tsx:301-302) is retained
  unchanged — the fix unblocks it, it does not replace it.

**Forbidden patterns** (grep keys for Phase 2-4 conformance):
- pattern: `min-w-0` added to `src/components/ui/dialog.tsx` — reason: fix must be
  scoped to the entry-dialog shell, not the global `DialogContent` primitive.
- pattern: per-call-site wrapper edits adding `min-w-0` to the `border-t pt-4` wrapper
  `<div>`s in `src/components/passwords/dialogs/personal-password-edit-dialog.tsx` or any
  `team-*-form.tsx` — reason:
  the class fix lives once in the shell; per-site edits are the inconsistency this
  plan avoids.
- pattern: `break-all` or `wrap-anywhere` added to the attachment filename `<p>` —
  reason: the list row must stay single-line ellipsis (`truncate`), not wrap.
- pattern: removal or alteration of `truncate` on the filename `<p>` — reason: the
  existing truncation is correct; only its ancestor shrink-blocking is the bug.

**Acceptance criteria**:
- A1: With an attachment whose filename is a 200-char unbroken string, the personal
  entry edit dialog shows no horizontal scrollbar; the filename renders on one line
  ending in an ellipsis, constrained to the dialog width.
- A2: Same for the team entry edit dialog (any entry type that renders
  `TeamAttachmentSection`).
- A3: Ordinary short filenames and all other dialog content render identically to
  before (no visual regression to width, spacing, or the form fields).
- A4: `npx vitest run` passes; `npx next build` succeeds.

**Consumer-flow walkthrough**: N/A — C1 changes a CSS utility class on a presentational
shell. It defines no API response shape, persisted-state shape, or payload consumed by
other code. No consumer reads a field from this change.

## Go/No-Go Gate

| ID | Subject                                                      | Status |
|----|-------------------------------------------------------------|--------|
| C1 | `EntryDialogShell` DialogContent gains `[&>*]:min-w-0`       | locked |

## Testing strategy

- **Primary verification is visual** (CSS layout bug): run the dev server, open an entry
  that has an attachment with a deliberately long filename, confirm no horizontal
  scrollbar and single-line ellipsis truncation in both personal and team edit dialogs.
- **Regression guard (scope caveat)**: `npx next build` confirms no TS/build break, and
  the full `npx vitest run` confirms nothing else regresses. Note that the
  attachment-section / team-attachment-section suites do NOT render `EntryDialogShell`
  (verified: neither test imports it), so they do not guard *this* change — the fix
  touches only the shell, not the attachment-section markup. The test that renders the
  changed component is `src/components/passwords/entry/entry-dialog-shell.test.tsx`, and
  it correctly asserts only title/children presence, NOT the className (a class assertion
  there would be decorative). Net: the layout effect of this change is intentionally
  unguarded by automated tests — see the E2E decision below and RT6 acceptance.
- **No new unit test asserting CSS classes**: asserting the literal presence of
  `[&>*]:min-w-0` in a snapshot would be a decorative test (it re-states the source, and
  removing the assertion would still leave the "test" green against the real bug — jsdom
  does not compute grid track sizing). The behavior is only observable in a real layout
  engine, which jsdom does not provide. (The global vitest environment is `node`; the
  attachment-section component tests opt into jsdom via a per-file
  `// @vitest-environment jsdom` pragma — either way there is no layout engine, so
  `scrollWidth`/`clientWidth` are 0 and a layout assertion is meaningless.)
- **E2E decision (recorded, not deferred)**: an E2E Playwright check asserting
  `scrollWidth <= clientWidth` on `[role='dialog']` with a long-filename fixture is the
  only test that would fail-before/pass-after. Resolved after checking the repo: an
  entry-edit-dialog E2E path exists (`e2e/page-objects/password-entry.page.ts`
  `openEditDialog()`, driven by `e2e/tests/password-crud.spec.ts`), and a
  `seedAttachment` helper exists (`e2e/helpers/password-entry.ts:163`, encrypts +
  DB-inserts an attachment row), but **no E2E spec opens the entry edit dialog and renders
  a seeded attachment** — the only `setInputFiles` in `e2e/` is the CSV *import* input
  (`import.page.ts`), and `seedAttachment` is exercised only by its own unit test. So the
  remaining cost of an E2E is "one new spec that seeds a long-filename attachment via the
  existing helper, opens the edit dialog, and asserts `scrollWidth <= clientWidth`" — not
  building attachment fixtures from scratch. **Decision: adding that E2E spec is out of
  scope for this one-class CSS fix (SC3). Primary verification is
  manual-visual per the User operation scenarios below + `npx vitest run` + `npx next
  build`.** The manual check MUST use a long UNBROKEN filename (≈200 chars, no
  whitespace) — a name with break opportunities won't reproduce the bug and would
  false-pass.

## Considerations & constraints

- **Scope contract**:
  - SC1 — Global `DialogContent` grid-item shrink behavior is deliberately NOT changed;
    owned by any future "make all dialogs shrink-safe" initiative. Out of scope here to
    keep blast radius at the entry dialog.
  - SC2 — The eight team-form wrapper `<div>`s and the personal wrapper `<div>` are NOT
    individually edited; the shell fix covers them. Not deferred work — deliberately
    avoided as the wrong layer.
  - SC3 — (a) Other potentially-overflowing dialogs in the app (settings, pickers) are
    not audited in this PR; only the reported entry-edit-dialog instance is fixed.
    (b) A new entry-attachment E2E fixture is NOT built (none exists; disproportionate for
    a one-class CSS fix — see Testing strategy); verification is manual-visual + build/lint.
- **Known risk**: `[&>*]:min-w-0` applies to *all* direct grid children, including
  `DialogHeader`. `DialogHeader` contains the title/description and does not rely on
  `min-width: auto` for its layout, so allowing it to shrink to 0 min-width is safe (its
  content wraps normally). Verify visually in A3.
- **Out of scope**: changing truncation style, adding tooltips showing the full filename
  on hover/focus (a possible UX enhancement, not part of this bug fix).

## User operation scenarios

1. Personal vault → open an entry that has an attachment named e.g.
   `verylongfilename_<180 more chars>.pdf` → click edit → observe the attachment row.
   Expect: single-line ellipsis, no horizontal scrollbar on the dialog.
2. Team vault → same, for an entry rendering `TeamAttachmentSection` (e.g. a team login
   entry with an attachment) → edit → observe.
3. Regression: any entry with only short filenames and no attachments → edit → the
   dialog looks identical to before the change.
