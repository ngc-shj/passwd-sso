# Plan Review: vault-action-button-split

Date: 2026-06-06
Review round: 1 (initial)

## Changes from Previous Round
Initial review — three expert sub-agents (functionality, security, testing) evaluated
the plan against the real source on branch `feature/three-pane-vault-layout`.

## Functionality Findings
- **F1 — Minor — degenerate single-item accelerator `⋮`** for BANK_ACCOUNT / IDENTITY /
  SOFTWARE_LICENSE (the `⋮` item duplicates the quick-copy button). Pre-existing in the
  `full` variant; not introduced by this plan. **Resolution**: noted in plan
  Considerations as an optional follow-up. Not a blocker.
- **F2 — Minor — C1 optional-flag default caution**: making `canEdit/canDelete/canShare`
  optional must not introduce a default that alters the `full`-variant gate.
  **Resolution**: added INV-C1.3.
- Verified correct: file/call-site completeness, C2 prop-removal cleanliness, no behavior
  lost (detail pane already wires every moved action), `onEdit`-as-attachment-signal must
  persist, `tc("edit")` valid (`PasswordCard.edit` exists EN+JA), `full` default
  byte-for-byte unchanged for `PasswordCard`, SECURE_NOTE edge case fine, DEC-1
  consistent. No Critical/Major.

## Security Findings
- **S1–S4 — PASS**: permission-gating parity holds (detail-pane gates are same-or-stricter;
  `rowActions.edit === rowActions.archive` in all descriptors), destructive-confirm flow
  unchanged (dialogs live in `EntryListView`), Edit visibility still gated by `onEdit`,
  attachment-edit signal stays coupled to `canEdit`.
- **S5-A — Low — accessible name for the new header Edit button**: the under-specified
  icon-button could ship without an accessible name. **Resolution**: C3 now mandates an
  `sr-only`/`aria-label` name + an accessible-name test. Added INV-C3.2 (keep `onEdit`
  sourced solely from the gated expression).
- No Critical findings; no escalation.

## Testing Findings
- **T1 — Critical — `password-row.test.tsx` C9 suite (`:389-518`) breaks** (asserts row
  `delete`/`restore`/`deletePermanently`, which leave the row). Plan was silent on it.
  **Resolution**: C2 acceptance now deletes the C9 block; coverage relocated via new C5.
- **T3 — Critical — phantom-match**: absence assertions on the Radix `⋮` pass vacuously
  unless the menu is opened first. **Resolution**: C2 acceptance mandates opening the
  menu and pairing absence with a presence assertion.
- **T2 — Major — no positive copy-item assertion** for the accelerator menu.
  **Resolution**: folded into the C2 paired presence+absence test.
- **T4 — Major — no test for the header Edit button** (present/absent/wired).
  **Resolution**: added to C3 acceptance with exact-name query guidance.
- **T5 — Major — no test that the detail pane is the sole home for delete/restore**.
  **Resolution**: new contract C5.
- **T6 — Major — `showEditButton` suppression + attachment-editability unobservable**
  with the bare attachment mock. **Resolution**: C4 acceptance upgrades the mock to
  surface `readOnly` and asserts `data-readonly="false"`.
- **T7 — Minor — optional captured-props guard** in `entry-list-view.test.tsx`.
  **Resolution**: added as optional in C2 acceptance (build already catches the type).
- **T8 — Minor — variant is by component identity, not `layoutMode`**. **Resolution**:
  documented in Considerations to avoid a redundant layout-mode test. No action.

## Adjacent Findings
None raised.

## Quality Warnings
None — all findings carried file:line evidence cross-checked against real source.

## Resolution Status
All findings incorporated into the plan (F1/T8 as documented notes; F2/S5-A/T1–T6 as
contract/acceptance changes; T7 as optional). No finding deferred or skipped. The plan's
five contracts (C1–C5) read `locked`. Round 1 converged — the Critical/Major findings
were all test-plan completeness gaps (no contract-logic redesign), so the contract
signatures did not flip back to `pending`.

## Note on process
Plan-only session (a PR is in flight on `feature/three-pane-vault-layout`). No branch
created, no code committed. Implementation deferred to the user's go-ahead.

---

# Phase 2 (Coding) + Phase 3 (Code Review)

Date: 2026-06-06 (after #515 merged to main)
Branch: `feature/vault-action-button-split` (from latest main)

## Implementation summary
Contracts C1–C5 implemented as planned. Production files:
- `entry-actions-menu.tsx` — added `variant: "full" | "accelerator"`; accelerator gates
  out all manage items via `showManageActions = variant === "full"`. Removed a
  pre-existing dead `fetchContent` prop (root-cause fix, not suppression) + its two
  pass-sites.
- `password-row.tsx` — passes `variant="accelerator"`, dropped the manage props.
- `entry-list-view.tsx` — stopped forwarding manage props to the row (the detail-pane
  render already owned them; no behavior lost).
- `password-detail-pane.tsx` — visible header Edit button (gated by `onEdit`, sr-only
  accessible name).
- `password-detail-inline.tsx` — `showEditButton` (default true); pane passes false.
- `password-card.tsx` — dropped the dead `fetchContent` pass-site + an unrelated dead
  `isSshKey` const surfaced on the now-touched file.

## Gates
- `npx vitest run`: 10935 passed (full suite). Detail suite: 130 passed (+9 vs pre-change).
- `npx next build`: compiled successfully.
- `npm run lint`: 0 warnings in any touched file (pre-existing repo warnings untouched).

## Phase 3 review (3 experts on the diff)
- Functionality: **No findings.** Verified full-variant byte-identical for PasswordCard,
  accelerator renders zero manage items, `fetchContent` removal safe, no double-Edit,
  SECURE_NOTE copyContent preserved.
- Security: **No findings.** Permission gating moved 1:1 to the pane (same descriptor ×
  permission predicates); confirm dialogs intact; Edit gated by `onEdit`; attachment-edit
  signal still bound to `canEdit`; header Edit has an accessible name; `fetchContent` was
  dead.
- Testing:
  - **T1 (Medium) — RESOLVED.** The accelerator `variant` gate (INV-C1.2) was untested:
    the row test passed only because props aren't forwarded (mutation-confirmed). Added
    `entry-actions-menu.test.tsx` rendering `variant="accelerator"` WITH every manage
    callback provided, asserting all manage items are absent. Mutation re-verified: setting
    `showManageActions = true` now fails the test.
  - **T2 (Low) — RESOLVED.** Added a pane test for independent item gating (restore present,
    delete-permanently absent).
  - Verified clean: C2 absence assertions are non-vacuous (open the Radix menu + pair with
    a present copy item), C3/C4 coverage correct, accordion full-menu regression pinned.

## Outcome
All findings resolved in-phase. Code uncommitted pending user go-ahead (global rule: do
not commit unless explicitly asked).
