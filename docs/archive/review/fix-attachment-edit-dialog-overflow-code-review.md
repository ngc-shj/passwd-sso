# Code Review: fix-attachment-edit-dialog-overflow
Date: 2026-07-20
Review round: 1

## Changes from Previous Round
Initial code review. Diff is a single one-line CSS class change
(`entry-dialog-shell.tsx:27` gains `[&>*]:min-w-0`) plus documentation-only `*.md` edits.

## Functionality Findings

**No findings.** Fix correct, complete, matches locked contract C1 exactly, no regression.
- I1/I2/I3 all satisfied; no forbidden patterns present in the diff.
- `[&>*]:min-w-0` correctly targets the grid items (DialogHeader + form children) of the
  DialogContent grid (`ui/dialog.tsx:70` `grid ... gap-4`), overriding the grid-item
  `min-width:auto` default so the `min-w-0`/`truncate` chain inside the attachment row
  can shrink and engage.
- Regression check: the Close button is `absolute top-4 right-4` (`ui/dialog.tsx:85`) —
  out of grid flow, not a grid item, so the variant does not affect it. `DialogHeader`
  shrink is benign (only title text, wraps naturally; `sr-only` description).
- Coverage complete: `PersonalEntryDialogShell` and `TeamEntryDialogShell` are bare
  re-exports of the one `EntryDialogShell`; all personal + team, new + edit dialogs and
  all entry types route through it. No divergent shell to sync (R8/R3 clean).

## Security Findings

**No findings.** Implemented diff matches the plan-stage security review exactly.
- Source diff is exactly the one class addition; no logic/data-handling/event-handler/
  import change.
- `min-w-0` on direct children hides/removes nothing. The one security-relevant element
  in this tree, `legacyAttachmentHint` (`attachment-section.tsx:414`), is a static
  translation string in a sibling `<p>`; column shrink lets it wrap, not clip. No warning
  banner / step-up reauth prompt lives in this shell's direct-child grid.
- No new info-disclosure or XSS surface: `{att.filename}` is auto-escaped React text
  (`attachment-section.tsx:408`); no `dangerouslySetInnerHTML`, no new attribute
  interpolation. Download is keyed on `att.id` (line 422), not the visual label.

## Testing Findings

No-new-test decision **confirmed correct as implemented** — no cheap, reliable,
non-decorative test exists for a CSS grid min-width fix (jsdom has no layout engine; a
class-presence assertion is decorative; the only valid fail-before/pass-after is a
real-browser Playwright `scrollWidth <= clientWidth` check). Two Minor documentation-
accuracy findings, both fixed in the plan this round:

**T1 — Minor** (fixed): the plan cited `attachment-section.test.tsx` /
`team-attachment-section.test.tsx` as a regression guard, but neither renders
`EntryDialogShell` (verified — no import), so they don't guard this change. The renderer
test is `entry-dialog-shell.test.tsx`, which correctly asserts only title/children (no
decorative className check). Plan's Regression-guard bullet corrected.

**T2 — Minor** (fixed): the E2E deferral note now names the existing `seedAttachment`
helper (`e2e/helpers/password-entry.ts:163`), so the future-cost estimate is honest
("one new spec using the existing helper", not "build fixtures from scratch").

RT6 (new-code-untested) is accepted and recorded (not silent): the layout effect is
intentionally unguarded because no non-decorative automated test is possible; verification
is manual-visual + `npx vitest run` (12778 passed) + `npx next build` (passed).

## Adjacent Findings
- [Adjacent] Security→UX (plan stage): a `title`/tooltip showing the full filename on
  hover would aid readability of truncated names. Explicitly scoped out; possible future
  enhancement.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R8 shared-component consistency: PASS (re-exports of one shell)
- R3 propagation: PASS (single shared shell covers all instances)
- Regression scope: PASS ([&>*] direct children only; absolute close button unaffected)

### Security expert
- RS1: N/A. RS2: N/A. RS3: PASS (escaped text, no innerHTML). RS4: PASS (downloads keyed
  on att.id). RS5: PASS (visual-only truncation). RS6: N/A.
- feedback_tailwind_standard_palette: PASS (standard utility class)

### Testing expert
- RT1: N/A. RT2: OK (shell test by text/role). RT5: OK (full suite 12778 passed).
- RT6 new-code-untested: FLAGGED-accepted (no non-decorative test possible; recorded).
- RT7 orphaned-check: FLAGGED (T1, doc-level, fixed). RT9: OK (no snapshots).
- Anti-Deferral: SATISFIED (T2 refines E2E cost estimate; SC3 records the deferral).

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 (the plan's "Verification
environment constraints" section is "none blocking"; the fix is a CSS-only change
verifiable in local dev).

## Resolution Status
### T1 [Minor] Plan cited non-rendering tests as regression guard
- Action: corrected the Regression-guard bullet in the plan's Testing strategy to state
  the attachment-section tests do NOT render EntryDialogShell and name
  entry-dialog-shell.test.tsx as the actual (className-free) renderer test.
- Modified file: docs/archive/review/fix-attachment-edit-dialog-overflow-plan.md

### T2 [Minor] E2E deferral cost estimate understated existing helper
- Action: updated the E2E-decision bullet to name the existing `seedAttachment` helper
  (e2e/helpers/password-entry.ts:163) so the remaining-cost estimate is accurate.
- Modified file: docs/archive/review/fix-attachment-edit-dialog-overflow-plan.md

All findings resolved. No Critical/Major findings in any round. Code diff unchanged by
this round (both findings were plan documentation-accuracy notes).
