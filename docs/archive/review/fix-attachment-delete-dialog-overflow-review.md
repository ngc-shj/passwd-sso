# Plan Review: fix-attachment-delete-dialog-overflow
Date: 2026-06-20
Review rounds: 2

## Changes from Previous Round

Round 1 reviewed a `t.rich` + per-call-site `break-all` span approach. Based on the
Functionality expert's F4/R3/R8 findings (the same overflow bug exists in sibling
delete dialogs — webhook URL, folder/tag names), and the user's decision to fix the
class at the shared component, the plan was rewritten for Round 2 to add a single
`wrap-anywhere` utility to the shared `AlertDialogDescription` default className. This
drops the i18n message change entirely. Round 2 re-verified the new approach.

## Functionality Findings

**Round 1:**
- F1 (Major): `t.rich` tag name `filename` vs value name `name` confusing/brittle.
  → RESOLVED in round 2 (t.rich approach dropped).
- F2 (Minor): `break-all` on inline span + grid `min-width:auto` interaction unverified.
  → n/a in round 2.
- F3 (Minor): `t.rich` ReactNode typing valid — no defect (confirmation).
- F4 (Major, R3/R8): identical overflow bug in `base-webhook-card.tsx:297` (raw URL),
  `sidebar.tsx:236`/`:257` (folder/tag names), unaddressed by per-call-site fix.
  → RESOLVED by design in round 2 (shared-component fix covers all of them).

**Round 2 (new approach):**
- New approach endorsed. `wrap-anywhere` confirmed real (tailwindcss 4.1.18,
  `dist/lib.js`: `"wrap-anywhere",[["overflow-wrap","anywhere"]]`).
- Core CSS correctness verified: `overflow-wrap: anywhere` (unlike `word-break:break-word`)
  introduces soft-wrap opportunities counted in min-content intrinsic sizing, so the
  grid item (`AlertDialogHeader` is `display:grid`, `min-width:auto`) shrinks below the
  longest token and the `max-w` cap is honored.
- No prose regression: `anywhere` is a no-op when whitespace break opportunities exist
  (spot-checked diverse callers).
- `cn()`/twMerge merge safe; grep confirms zero call sites pass any conflicting
  `break-/wrap-/overflow-/whitespace` class (none pass `className` at all).
- F5 (Minor, doc-only): plan overstated call-site count ("116" / "≥45 files"); actual
  ~42 JSX renders across ~44 files. → Corrected in plan prose.

## Security Findings

**Round 1:** No blocking findings.
- S1 (Minor/informational): `t.rich` keeps the value React-escaped; next-intl parses the
  message template for tags, not the value — no XSS path, no `dangerouslySetInnerHTML`.
- S2 (Minor/informational): filename is attacker-influenceable but validated at upload
  via allowlist regex `SAFE_FILENAME_RE` (`src/lib/validations/send.ts:18`) at both
  personal (`attachments/route.ts:242`) and team routes — HTML metacharacters excluded.
- S3 (Minor/informational): filename capped at 255 bytes server-side
  (`FILENAME_MAX_LENGTH`, `common.ts:95`) + `.slice(0,255)` — no layout-bomb/DoS.

**Round 2:** The new approach is a CSS-only change with no value-rendering path change
at all (plain `t(...)` interpolation retained, React-escaped as before). Security
surface is strictly smaller than Round 1; all Round 1 conclusions hold. No findings.
No Critical findings → no Opus escalation needed.

## Testing Findings

**Round 1:**
- T1 (Minor): component test mocks (`attachment-section.test.tsx:6-8`,
  `team-attachment-section.test.tsx:30-33`) lacked `.rich`; dormant because no test
  opens the delete dialog. → MOOT in round 2 (no `t.rich` used).
- No existing unit/E2E test asserts `confirmDeleteDescription` text; "no new test"
  justified (no visual-regression harness; class assertion would be decorative).

**Round 2 (new approach):**
- T1 fully resolved/moot — zero `t.rich` (only unrelated `privacy-policy/page.tsx`).
- No snapshot tests exist in repo (`*.snap` empty; no `toMatchSnapshot`). No className
  assertion targets `AlertDialogDescription`. `alert-dialog.test.tsx` asserts via
  role/text only — unaffected.
- E2E specs select via `[role='alertdialog']` + button role/name + text; no geometry/
  className/screenshot assertions — unaffected.
- T2 (Minor, informational): `alert-dialog.test.tsx` cannot cover wrap behavior (jsdom
  has no layout engine) — accepted gap, manual visual verification is the path.
- APPROVE.

## Adjacent Findings

None requiring cross-routing. F4 (functionality) overlapped with a general UI-consistency
concern and was resolved structurally by the shared-component approach.

## Recurring Issue Check

### Functionality expert
- R3 (propagation): Round 1 APPLICABLE (siblings unfixed) → Round 2 COMPLETE (shared
  component reaches webhook/folder/tag/attachment dialogs and all future ones).
- R8 (UI pattern inconsistency): Round 1 APPLICABLE → Round 2 RESOLVED structurally
  (fix at SSoT; no "did this dialog get fixed?" gap).
- R37 (jargon): n/a — strings unchanged, user-domain.
- R1, R2, R4-R7, R9-R36, R38-R39: n/a (CSS-only shared-component change).

### Security expert
- Output encoding / XSS: PASS (filename React-escaped; no innerHTML).
- Input validation / allowlist: PASS (`SAFE_FILENAME_RE`).
- Length cap / DoS: PASS (255-byte cap).
- Injection (SQL/shell/path): PASS (Prisma parameterized; path separators rejected).
- Authz/IDOR: PASS (unchanged; ownership + RLS intact).
- i18n parity: PASS (no message-shape change in round 2).
- RS1-RS5 + remaining R1-R41: n/a (presentational change, no auth/crypto/network/persistence).

### Testing expert
- R7 (E2E selector / phantom-match): PASS (role/text selectors stable; no aria change).
- R19 (assertion alignment / className snapshots): PASS (no `*.snap`, no className
  assertion on the component).
- R1-R6, R8-R18, R20-R41, RT1-RT7: n/a.

## Verdict

Both Round 2 reviews return no Critical/Major findings. Plan locked. Single contract
C1: add `wrap-anywhere` to `AlertDialogDescription` default className in
`src/components/ui/alert-dialog.tsx:125`.

## Phase 2 — Implementation

Implemented C1 verbatim (1-line diff):
```
-      className={cn("text-muted-foreground text-sm", className)}
+      className={cn("text-muted-foreground text-sm wrap-anywhere", className)}
```

## Phase 3 — Contract conformance

- Implementation is byte-identical to locked C1; the same 1-line change was already
  verified across both Phase 1 review rounds (utility existence, grid min-content
  shrink semantics, prose no-op, XSS surface, test breakage). No new expert round run
  — re-reviewing the identical line a third time yields no new findings.
- Forbidden-pattern grep: `t.rich(...confirmDeleteDescription)` = 0; `break-all` in
  `alert-dialog.tsx` = 0; `wrap-anywhere` present = 1. All pass.
- Mandatory checks: `npx vitest run` → 11530 passed / 1 skipped; `npx next build` →
  success.
