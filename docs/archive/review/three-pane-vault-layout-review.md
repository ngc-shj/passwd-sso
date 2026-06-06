# Plan Review: three-pane-vault-layout
Date: 2026-06-04
Review round: 4 (FINAL — converged) — Round 4 below; Rounds 3/2/1 retained.

## Round 4 — Convergence (FINAL)
Single combined-lens convergence pass. All four cross-contract traces verified clean:
(1) T14 trace `row click → onToggleExpand(id) → onActivate(entryById(id))` realizable from `allEntries`;
(2) INV-C5.5 mount accordion→master-detail flip fires no `getDetail` (activeEntry null at load, no auto-select);
(3) INV-C4.3 bulk `onActivate(null)` type-valid against `(entry|null)=>void`;
(4) `lock()` on `pageshow` is safe (no navigation, idempotent delegation-revoke, guarded setVaultStatus).
- **S13 [Low]** INV-C1.6 rationale wrongly listed "delegation revoked" as a unique lock() benefit (pagehide
  already revokes) → **APPLIED**: corrected to the accurate unique benefit (zeroes wrappedKeyRef/salt/ECDH-pub
  + clears encryptionKey).
- **F19 [Info]** `EntryOverview` naming → **APPLIED**: reuse existing `DisplayEntry` (or `Pick`), no parallel type.
- **T16 [Info]** confirmed no test-contract collision (password-card.test vs password-list.test target
  different boundaries).

**Verdict: all 7 contracts LOCKED. 38 findings raised + resolved across 4 rounds. No Critical/Major open.**

---

## Round 3
Review round: 3 — see below.

## Round 3 — Changes from Previous Round
All three experts verified the R2 `activeEntry` unification is architecturally sound and secure (no Critical/
High; F11/F13/F14 confirmed dissolved; no new plaintext exposure — overview already decrypted in list state).
10 specification-precision findings raised and applied:
- **F15 [Major]** `useLayoutMode()` SSR/hydration → **APPLIED**: INV-C5.5 (SSR-safe via useSyncExternalStore,
  return "accordion" on server/first render); matchMedia polyfill wording corrected.
- **F16 [Major]** INV-C4.3 bulk-path "fire onEntryRemoved per id" not achievable (useBulkAction.onSuccess is
  zero-arg, clearSelection first) → **APPLIED**: split into single-entry (onEntryRemoved(id)) vs bulk
  (PasswordList checks activeEntryId absence in refreshed allEntries, calls onActivate(null)).
- **F17 [Low]** accordion inline-render predicate → **APPLIED**: `activeEntryId===id && layoutMode==="accordion"`
  (prevents double-render / two-plaintext in master-detail).
- **F18 [Low]** forbidden-pattern false-positives on SC1 consumers → **APPLIED**: path-anchored to
  password-list.tsx only; team/emergency keep their own expandedId.
- **S10 [Low]** C5 regex can't catch hoist via unnamed wrapper/VaultGate relocation → **APPLIED**: reframed to
  structural assertion (activeEntry/detailData useState only in password-dashboard.tsx) + VaultGate-ancestor
  test; named dashboard/page.tsx (below gate, safe).
- **S11 [Low]** INV-C1.6 forced lock must call lock() not bare setVaultStatus → **APPLIED** (clears
  wrappedKeyRef/salt/ECDH + revokes delegation).
- **S12 [Info]** debounce test must assert coalescing → **APPLIED** (call-count < keypresses).
- **T13 [Major]** matchMedia mock must be stateful addEventListener + flip via act()+listener (not bare
  re-render → vacuous pass) → **APPLIED** with precondition assert (layoutMode flipped) before count assert.
- **T14 [Major]** C3 "unchanged public props" vs testing "click→activate" contradiction → **RESOLVED**:
  PasswordCard public props UNCHANGED (expanded/onToggleExpand); rename only at PasswordList↔dashboard
  boundary; password-card.test.tsx:132 + 3 SC1 consumers untouched; orphaned decrypt mocks explicitly DELETED
  (not "moved").
- **T15 [Minor]** parity test must compare two rows' secondary text to each other via queryable handle →
  **APPLIED**.

---

## Round 2
Review round: 2 — see below; Round 1 retained at bottom.

## Round 2 — Changes from Previous Round
All 20 Round-1 findings verified RESOLVED by all three experts. The layer-correction fixes (F6 lift to
dashboard) exposed a deeper data-ownership split, surfaced as F11/F13/F14/T9. Root-cause fix applied:
**unified `expandedId` + `selectedId` into a single dashboard-owned `activeEntry` (overview row)** and made
`layoutMode` come from a JS `useLayoutMode()` matchMedia hook — dissolving F11/F13/F14/T9 together.

### Round 2 findings & resolutions
- **F11 [Major]** personal `getDetail` can't reach entryType/urlHost/requireReprompt/title on the 3-pane path
  (they live in PasswordList.allEntries, dashboard only had a ref) → **APPLIED**: C4 reframed so `onActivate`
  carries the overview row; dashboard owns `activeEntry` and builds the personal closure from it.
- **F12 [Major]** INV-C4.3 id-propagation callback unspecified + bulk removal paths missed → **APPLIED**:
  `onEntryRemoved(id)` signature defined; all removal sites enumerated (3 single handlers + bulk + empty-trash).
- **F13 [Major]** INV-C5.4 bridge spanned two components, no plumbing, feedback-loop risk → **APPLIED**:
  dissolved — single `activeEntry` persists across the breakpoint; bridge removed entirely.
- **F14 [Minor]** personal `getDetail` omits title → **APPLIED**: title sourced from `activeEntry` overview.
- **S6 [Minor]** INV-C1.5 lacked a regression guard → **APPLIED**: C5 forbidden-pattern bans
  selectedId/activeEntry/setDetailData state in layout.tsx / dashboard-shell.tsx.
- **S7 [Minor→correctness]** INV-C1.6 "re-check" collides with vault-context.tsx:213 unlocked-sticky rule →
  **APPLIED**: reworded to force a CLIENT LOCK when restored key is null (not a server re-check).
- **S8 [Minor]** C7 arrow-nav transient decrypt → **APPLIED**: INV-C7.4 debounce ~150ms + obey INV-C4.4.
- **S9 [Minor]** SC4 Anti-Deferral incomplete → **APPLIED**: worst/likelihood/cost added (cost near-zero;
  visibilitychange listener already exists at auto-lock-context.tsx:87) + TODO marker.
- **T9 [Major]** INV-C5.3 (CSS-only) vs INV-C5.4 (JS-seeded) contradiction → **APPLIED**: `useLayoutMode()`
  matchMedia hook is the single JS source; unit-testable; bridge eliminated.
- **T10 [Major]** moved decrypt mocks must assert on hook's `detailData` (not a stubbed sink) → **APPLIED**
  in C3 test-migration.
- **T11 [Minor]** INV-C1.6 bfcache test unassigned → **APPLIED**: dispatch-`pageshow` unit test + manual line.
- **T12 [Minor]** INV-C6.4 "9th type" aspirational → **APPLIED**: replaced with per-type rich-vs-compact
  parity test.
- RS2 note (security): `use-reprompt.ts:79` existing `eslint-disable` must migrate with its documented reason
  intact, not be dropped/broadened — noted for Phase 2.

---

## Round 1
Date: 2026-06-04
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

- **F1 [Major]**: C3 extraction silently diverges personal vs team `InlineDetailData` assembly. Personal path
  builds `InlineDetailData` inside PasswordCard from the raw API row (`raw.requireReprompt ?? prop`,
  `raw.createdAt/updatedAt`, `urlHost` from prop, `passwordHistory`) — password-card.tsx:337-405; team
  `getDetailProp` returns a fully-formed object (teams/[teamId]/page.tsx:423-491). C1's `getDetail` must
  return the COMPLETE `InlineDetailData` for both paths; the hook owns zero field-mapping. Add per-consumer
  walkthroughs asserting requireReprompt/urlHost/createdAt/updatedAt/passwordHistory are produced by each
  consumer's `getDetail`. **Resolution: APPLIED** (C1 rewritten).
- **F2 [Major]**: `setDetailData(null)` is called imperatively for cache invalidation on refresh
  (password-card.tsx:909) and edit-onSaved (:928). C1's return shape exposes no setter/invalidate, and C3's
  forbidden pattern bans `setDetailData(` outside the hook — edit-then-stale-pane regression. C1 must expose
  `invalidate()`/`refetch()`. **Resolution: APPLIED** (C1 return shape + walkthrough).
- **F3 [Major]**: INV-C1.3 mislabeled as "preserve accordion guarantee" — the accordion does NOT clear on
  lock today (clears only on `!expanded`, password-card.tsx:310-316). It is NEW behavior. Specify the
  `vaultStatus` source per consumer. **Resolution: APPLIED** (re-labeled; merged with S1).
- **F4 [Major]**: C1 signature assumes `useVault()` (`encryptionKey`/`vaultStatus`), but team consumers use
  `useTeamVault()` and never read `useVault().encryptionKey` — gating the hook on a null key breaks team
  decrypt. Make `encryptionKey` advisory (key access delegated to the injected `getDetail`); hook gates only
  on `entryId != null`. Add team + team-archived walkthroughs. **Resolution: APPLIED** (C1 rewritten).
- **F5 [Major]**: EntryListShell selection-mode external checkbox (entry-list-shell.tsx:95-107) + compact row
  at ~320px + master-detail select = triple click-overload, unspecified layout. Add walkthrough: in
  master-detail + selectionMode, row click routes ONLY to checkbox toggle; specify checkbox placement at
  320px. **Resolution: APPLIED** (C4 INV-C4.4 + C6 walkthrough).
- **F6 [Major]**: INV-C4.3 (clear selectedId on optimistic delete) is at the wrong layer — `selectedId` lives
  in dashboard, but optimistic removals run in PasswordList (password-list.tsx:256-306) and carry no id back
  up. Dashboard cannot learn the removed id. Lift the entry array+handlers to the dashboard OR propagate the
  affected id upward. **Resolution: APPLIED** (C4 rewritten — id propagation).
- **F7 [Minor]**: INV-C4.2 must add `setSelectedId(null)` inside the existing during-render
  `if (prevViewKey !== viewKey)` block (password-dashboard.tsx:139-142), not a separate effect (avoids
  one-frame stale pane). **Resolution: APPLIED**.
- **F8 [Minor]**: C7 `Esc` is quadruple-overloaded with the existing window keydown cascade
  (password-dashboard.tsx:162-221). Attach C7's handler to the list-pane container (not window); define Esc
  precedence. **Resolution: APPLIED** (C7 INV-C7.3).
- **F9 [Minor]**: Rich card + compact row each carry 8 entry-type branches → drift (matches
  project_extension_parallel_impl). Extract shared per-type secondary-line + copy/menu sub-components.
  **Resolution: APPLIED** (C6 sub-contract).
- **F10 [Minor]**: Breakpoint resize crossing `lg` loses the active entry (`expandedId` list-local vs
  `selectedId` dashboard, not bridged). Seed one from the other on layoutMode transition, or document the
  reset. **Resolution: APPLIED** (C5 INV-C5.4 — bridge).

## Security Findings

- **S1 [Major]**: INV-C1.3's real clear-on-lock mechanism is the `VaultGate` unmount (vault-gate.tsx:50-52;
  dashboard mounted under VaultGate at layout.tsx:30), NOT a per-hook effect. Add invariant: the detail pane
  and `usePasswordEntryDetail` state holder MUST render inside the VaultGate UNLOCKED subtree; MUST NOT be
  hoisted into `dashboard/layout.tsx`. The `vaultStatus` effect is defense-in-depth and should also key on
  `encryptionKey === null`. **Resolution: APPLIED** (C1 INV-C1.3 rewritten + INV-C1.5 placement).
- **S2 [Minor]**: `useReprompt` 30s cache (use-reprompt.ts:6) lives in a `useRef`; keep it inside the
  `key={entryId}` boundary so it tears down per selection and per lock-unmount. If lifted, invalidate on
  entryId change + on lock. **Resolution: APPLIED** (C2 INV-C2.3).
- **S3 [Minor]**: Tab-hidden window before auto-lock fires (hidden timeout default 5min,
  auto-lock-context.tsx:8-9) keeps one entry's plaintext resident in a backgrounded tab. Name the tradeoff
  in R-risk-2 OR add clear-on-hide (`visibilitychange→hidden` clears detailData, re-decrypt on return).
  **Resolution: APPLIED** (R-risk-2 + optional clear-on-hide noted; clear-on-hide deferred SC4).
- **S4 [Minor]**: bfcache restore can re-display decrypted state after `pagehide` zeroed the key
  (vault-context.tsx:282). Add a `pageshow`/`event.persisted` re-check so VaultGate unmounts the pane.
  **Resolution: APPLIED** (C1 INV-C1.6 / transition list).
- **S5 [Minor]**: `key={entryId}` is the ENTIRE defense against cross-entry reveal carry-over; elevate from
  advisory regex to a hard acceptance assertion. **Resolution: APPLIED** (C2 acceptance + testing).
- SC2 (defer URL deep-linking) reasoning VALIDATED: React `useState` selectedId is never serialized to
  URL/history/sessionStorage — no metadata leak (heap-only via bfcache, see S4).
- No Critical findings. RS4: plan doc is clean (generic placeholders only).

## Testing Findings

- **T1 [Major]**: INV-C1.4 cancel-flag race test will vacuous-pass unless the race window is forced open.
  Use deferred/controllable promises (resolve stale fetch AFTER new selection), assert the stale resolve
  actually fired, and add a regression guard (delete `cancelled` → test goes red). password-card.tsx:322,
  407-409 is the primitive; it must be on the test call path (RT5). **Resolution: APPLIED** (testing strategy).
- **T2 [Major]**: INV-C1.3 unit test must NOT use fake timers — the hook clears on a `vaultStatus` state
  transition, drivable by re-render in jsdom. Split: (1) hook-clears-on-status-change (unit, no timers);
  (2) auto-lock-produces-transition (already covered by auto-lock-context.test.tsx + one real-clock manual,
  VC3). **Resolution: APPLIED** (testing strategy + VC3 clarified).
- **T3 [Major]**: C3 refactor moves the decrypt-mock boundary. Existing mocks (password-card.test.tsx:28-55
  decryptData/crypto-aad/fetchApi; password-list.test.tsx:24-41) exercise logic that moves into the hook —
  "tests pass unchanged" is false or silently false-green. Add a test-migration subsection: decrypt mocks
  move to `use-password-entry-detail.test.tsx`; password-card.test keeps render/click/favorite (prop-based).
  **Resolution: APPLIED** (C3 test-migration subsection).
- **T4 [Major]**: RT6 — `PasswordRow` non-layout behavior (click→onSelect, title/username render, menu) is
  jsdom-testable and must ship a same-PR unit test; plan routes C6 only to E2E. **Resolution: APPLIED**.
- **T5 [Minor]**: INV-C4.4 (bulk-select vs detail-select) has no assigned test; jsdom-testable. Add a C4
  unit case. **Resolution: APPLIED**.
- **T6 [Minor]**: "Regression guard" is aspirational prose. Operationalize: each clear test asserts the
  positive precondition (entry IS resident) before triggering the clear, so removing the final assertion
  leaves an unconsumed precondition. **Resolution: APPLIED**.
- **T7 [Minor]**: E2E viewports — use 1280 (3-pane), 1100 (list+detail), 1023 (accordion) via
  `setViewportSize` within the Desktop Chrome project to pin both breakpoint edges. **Resolution: APPLIED**.
- **T8 [Adjacent Major]**: INV-C1.2 no-hover/prefetch-decrypt is regex-only; add a behavioral test
  (`userEvent.hover` → assert `getDetail` not called). **Resolution: APPLIED**.

## Adjacent Findings
- [Func→Security] persistent pane extends plaintext lifetime — ruled on by S1/S3 (bounded by auto-lock; pane
  stays under VaultGate). Accepted with bound stated in R-risk-2.
- [Func→Testing] clear-on-lock/delete regression tests — covered by T1/T2/T6.
- [Security→Testing] key={entryId} + clear-on-lock must be mutation-resistant — covered by T6/S5.
- [Testing→Security] INV-C1.2 testability — covered by T8.

## Quality Warnings
None — all findings carried file:line evidence and concrete fixes.

## Recurring Issue Check
### Functionality expert
R1–R3 N/A (no request boundary/auth/SQL). R4 PASS (no new plaintext logging). R5 partial — team getDetailProp
swallows errors (card:331-333), reconcile with C1 `error`. R6 N/A. R7 PASS. R8 N/A. R9/R10 PASS
(layoutMode 2-value union acceptable). R11 FAIL-adjacent — password-card.tsx 970 lines, refactor should split
(F9). R12 related. R13–R17 N/A. R18 OPEN — "select an entry"/"N selected" need en/ja i18n keys (no カタカナ).
R19 N/A. R20 RELEVANT — F1 is a write-read shape mismatch. R21 PASS — AAD untouched (preserve per-path AAD in
each getDetail closure). R22 N/A. R23 RELEVANT — F9 parallel-impl drift. R24-R37 N/A at plan stage. PR cadence:
single PR after all 7 contracts (SC1 team/emergency 3-pane deferred).

### Security expert
R1–R9 N/A (no SQL/XSS/authn/authz/CSRF/secrets/validation/rate-limit/crypto added). R10 APPLIES — S1/S2/S3/S4
plaintext lifetime + clear-on-lock. R11 checked — error logged is Error not plaintext. R12–R24 N/A. R25
APPLIES — bfcache (S4). R26 — detailData not zeroable, cleared by unmount/null (S1). R27 N/A (personal only).
R28–R37 N/A. RS1 N/A (no endpoints). RS2 N/A (no comparisons). RS3 N/A (no migration). RS4 APPLIES — plan doc
clean; reminder to use `<test-user-email>` placeholders in the manual-test doc.

### Testing expert
R1–R18 N/A (UI-only, no migration/endpoint/schema). R19 HIT — T3 mock drift. R20–R37 N/A. RT1 OK (vitest+
jsdom + real-DB + Playwright present). RT2 honored (recs are jsdom-behavioral; layout→Playwright). RT3 — T2
mis-framing. RT4 HIT — T1/T6 vacuous-pass. RT5 HIT — T1 cancel primitive on call path. RT6 HIT — T4 PasswordRow.
