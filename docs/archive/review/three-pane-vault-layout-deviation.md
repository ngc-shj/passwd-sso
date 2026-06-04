# Coding Deviation Log: three-pane-vault-layout

## D1 — Personal getDetail extracted to a shared module (commonization)
The personal `getDetail` field-assembly (originally planned to live inside PasswordCard's closure) was
extracted to `src/lib/vault/build-personal-get-detail.ts` so BOTH PasswordCard (accordion) and the dashboard
pane consume one source of truth. Aligns with the user commonization directive (INV-C1.7 / INV-C3.1); also
made the assembly directly unit-testable (`build-personal-get-detail.test.ts`, 16 tests — closes the R16/
INV-C3.1 coverage gap that arose when Batch 2 deleted the decrypt mocks from password-card.test.tsx).

## D2 — Pre-existing impure-date latent bug fixed in password-card.tsx (side-fix)
PasswordCard's expiry-badge read `new Date()` / `Date.now()` during render (pre-existing on `main`, lines
612/614). The React Compiler bails out of analyzing complex components; simplifying PasswordCard in Batch 2
re-enabled analysis and surfaced it as a hard lint ERROR. Fixed at root cause with a lazy `useState(() =>
Date.now())` snapshot + pure `new Date(ms)` math. Per CLAUDE.md fix-all-errors-in-touched-files. No
suppression used.

## D3 — C1 hook restructured from imperative-effect-clear to render-derived (contract-preserving)
`usePasswordEntryDetail` originally cleared `detailData` via synchronous `setState` in effects (INV-C1.1
clear-before-fetch, INV-C1.3 clear-on-lock). The React Compiler rule "Calling setState synchronously within
an effect" flagged both as errors. Restructured so the current `detailData`/`error`/`loading` are DERIVED
during render from entryId-tagged state; effects only write asynchronously (in `.then`/`.catch`). This
satisfies the rule AND strengthens the invariants (the derived `result?.id === entryId` guard is a second
line of defense for INV-C1.4 on top of the cancel flag). Public return shape unchanged; all 13 hook tests
pass unchanged.

## D4 — Pane edit/share dialogs hosted in PasswordDashboard (smart-container approach)
Per the plan's allowance, the master-detail pane's edit/share use the SAME dialog components
(`PasswordEditDialogLoader`, `ShareDialog`) mounted by the dashboard — no duplication of dialog/handler
logic vs PasswordCard. PasswordCard remains the dialog owner for accordion mode.

## D5 — Share-from-row-menu in master-detail activates the entry (within SC3)
In master-detail mode, choosing Share from the compact row's overflow menu activates the entry (opens the
pane) rather than immediately opening the share dialog, because `PasswordDetailInline` exposes no share
button. Acceptable within SC3 (edit/action-in-pane deferred). `TODO(three-pane-team-emergency): wire
share-from-pane`.
