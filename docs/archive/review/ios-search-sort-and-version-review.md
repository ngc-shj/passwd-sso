# Plan Review: ios-search-sort-and-version

Date: 2026-07-07
Review rounds: 2 (converged)

## Changes from Previous Round

Round 1: initial three-expert review (Functionality, Security, Testing) against the initial plan.
Round 2: incremental verification of all Round-1 fixes + six new design cross-checks; one new minor finding (R2-T1), fixed.

## Functionality Findings (Round 1)

- **F1 [Major] — RESOLVED**: Plan claimed the sort "mirrors web `EntrySortOption`" with four keys, but web (`src/lib/vault/entry-sort.ts:1`) has only THREE (`title`/`createdAt`/`updatedAt`); there is no `website` key on web. Fix: reframed `website` as an iOS-only key with fully-specified local semantics (Objective §2, FR2, C1); removed all "4 keys mirror web" claims.
- **F2 [Major] — RESOLVED**: nil dates are not a rare team/legacy edge — they are the state for ALL personal entries until the first post-upgrade sync backfills them; and `urlHost` is `""` (never `nil`) for non-web entries. Fix: C1 now specifies nil-date-last for date keys AND `""`-urlHost-last for `website`; user-scenario 5 documents the post-upgrade window.
- **F3 [Minor] — RESOLVED**: default sort `.title` diverges from web's `.updatedAt`. Fix: FR3 documents this as a deliberate divergence (date keys are nil until first sync), not an oversight.
- **F4 [Minor] — RESOLVED**: sort-menu UI location was unspecified. Fix: C6 places it in the top-level `VaultListView` toolbar; SC5 defers in-category sort control.
- **F5 [Minor] — RESOLVED (documented)**: two search surfaces (top bottom-bar + category `.searchable`) write the same shared `viewModel.searchQuery`. Fix: cross-screen query UX consequences enumerated as manual-sim (VC1) verification items.
- **F6 [Minor] — RESOLVED**: an existing dual-variant ISO parser (`AutofillTokenRefresher.parseISO8601`) already does what C4 needs; a single-formatter reimplementation would drop non-fractional dates. Fix: C4/Technical-approach mandate REUSE + relocate-to-Shared (free function), not reimplement.

## Security Findings (Round 1)

- **S1 [Low] — RESOLVED**: category-screen `.searchable` must not render entry rows outside the `isScreenRecording` gate. Fix: C8 invariant + forbidden-pattern (`List(entries` outside the `!isScreenRecording` else branch); mirror `DemoVaultView.swift:45`.
- **S2–S6 [Info]**: createdAt/updatedAt confirmed non-secret (server already stores/returns them, not in the encrypted blob); sort-key persistence carries no PII; version disclosure benign; ISO parse-to-nil is DoS/ReDoS-safe (`ISO8601DateFormatter` is fixed-grammar); missed `CacheEntry(` date sites degrade sort order only, never confidentiality. No action.
- **No Critical/High security findings.** No escalation to Opus warranted.

## Testing Findings (Round 1)

- **T1 [High] — RESOLVED**: `AppVersion.display(bundle:)` is untestable — `Bundle` has no synthetic-infoDictionary initializer. Fix: C9 uses a string-parameter seam `display(marketing:build:)`; forbidden-pattern bans `display(bundle:`.
- **T2 [Medium] — RESOLVED**: C6's VM persistence test would pollute the shared App Group suite. Fix: `VaultViewModel.init(settings: AppSettingsStore = AppSettingsStore())`; tests inject a per-test `UserDefaults(suiteName: UUID)`.
- **T3 [Medium] — RESOLVED**: favorites-first tested under only one key. Fix: C1 acceptance + T-SORT assert favorites-first for ALL four keys.
- **T4 [Medium] — RESOLVED**: nil-last tested one key; "nil-vs-nil stable" invariant likely false under Swift's non-stable `sorted(by:)`. Fix: C1 mandates stability via an `enumerated()` index tie-break; T-SORT asserts nil-last for both date keys AND stability.
- **T5 [Low] — RESOLVED**: ISO tolerance (fractional/non-fractional) tested one form. Fix: T-DATE asserts three forms (fractional, non-fractional, garbage→nil).
- **T6 [Low] — RESOLVED**: proposed category-search assert re-tested existing `filteredSummaries` behavior, not the new binding. Fix: T-SEARCH-CAT targets the category-scoped `entries` computed property; no vacuous `#file` grep gate.
- **T7 [Low] — RESOLVED**: no end-to-end test that `decryptOverview` actually threads the dates. Fix: T-DATE-E2E in `VaultViewModelTests` drives the real decrypt path.

## Round 2 Findings

- **R2-T1 [Minor] — RESOLVED**: relocating `parseISO8601` out of `AutofillTokenRefresher` would break existing callers — production `Self.parseISO8601` (`AutofillTokenRefresher.swift:41`) and tests (`AutofillTokenRefresherTests.swift:86/114/115/116`). Fix: C4 mandates a thin forwarding static shim on `AutofillTokenRefresher` delegating to the Shared free function (DRY, zero call-site churn).
- **Round-2 design cross-checks (all PASS)**: (1) index tie-break does not conflict with the favorites-first primary split; (2) `VaultListView`'s zero-arg `VaultViewModel()` correctly uses the default (real) store in prod, injected store in tests — no leakage; (3) no stale "four keys mirror web"; (4) `init(settings:)` default arg keeps all ~20 existing `VaultViewModel()` call sites compiling; (5) Swift evaluates `display()` default args per-call, so no static-init ordering hazard; (6) R10: Shared has no deps → the relocated free function is safe.

## Adjacent Findings

- T4 flagged the "nil-vs-nil preserves input order" invariant as partly a correctness issue (Swift `sorted(by:)` not stable) — routed into C1 as the mandatory index tie-break, not left as a testing-only note.

## Recurring Issue Check

### Functionality expert
- R9 (async-in-tx): N/A (no DB, pure sync date conversion).
- R10 (circular import): checked — relocating only the static parser to Shared (which has no deps) is safe; do not move the whole `AutofillTokenRefresher` type.
- R12 (enum consumers / i18n): `EntrySortOption` new enum — C10 adds en/ja catalog keys for all labels; `LocalizationCatalogTests` enforces coverage; no exhaustive-switch consumers to break.
- R42 (member-set): `CacheEntry(` construction sites enumerated and verified accurate; only the personal `toPersonalCacheEntry()` mapper carries dates; team mapper + passkey-registration append + debug/demo sites correctly pass nil.

### Security expert
- RS1 (secrets in persistence/logs): PASS — dates non-secret, sort-key non-PII, nothing logged.
- RS2 (E2E boundary): PASS — new fields are cache-row metadata, forbidden from the encrypted blob (C5).
- RS3 (info disclosure via new UI): WATCH → addressed by S1 (screen-recording gate).
- RS4 (auth/authz on new endpoints): N/A — no server change.
- RS5 (input validation/injection): PASS — ISO parse fail→nil, no throw, no ReDoS.

### Testing expert
- RT1 (vacuous gates): addressed — no `#file` grep gate; T-L10N uses `#filePath`.
- RT2 (test isolation): addressed by T2 (injected per-test UserDefaults suite).
- RT3 (mock-at-boundary): addressed by T1 (string seam, not `Bundle`).
- RT4 (fail-for-a-real-reason): addressed across T1/T3/T4/T5/T6/T7.
- RT5 (real-boundary not mocked away): golden-fixture date test avoids a live server (VC2).
- RT6 (per-member coverage): addressed by T3/T4 (per-key assertions).
- RT7 (assert behavior not restatement): addressed by T6.

## Outcome

All Round-1 findings (F1–F6, S1, T1–T7) and the single Round-2 finding (R2-T1) are resolved and reflected in the plan's contracts. All 10 contracts are `locked`. No Critical/Major findings remain. Ready for Phase 2 (implementation).
