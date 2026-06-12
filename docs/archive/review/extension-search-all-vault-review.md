# Plan Review: extension-search-all-vault

Date: 2026-06-12 (round 1) / 2026-06-13 (rounds 2-3)
Review round: 3 — COMPLETE (all experts: No findings)

---

# Round 3 (verification — final)

## Changes from Previous Round

Round-2 fixes applied: I7 header-rendering rule for empty results (F11), I10 shadow rename (F5), A9 split into A9a/A9b with `within()` scoping (T7), A7 enforcement-mapping clarification (T8), PASSKEY fixture title constraint (T9), SC5 extended with AUTOFILL sender validation, SC6 added (normalizeHost TLD guard).

## Results

- **Functionality**: F11/F5 fixes verified correct and consistent with I2/A4/I5; no new findings. One marginal note (A8 could also assert the no-results message when results are empty) — folded into A8 wording; the retained existing test covers the message.
- **Security**: SC5/SC6 deferrals verified against code — both pre-existing, not widened by this PR, quantified, grep-able TODO markers, routed for follow-up review. A9a/A9b fully discriminate the I8 property (A9a catches Fill-shown-for-cross-domain-LOGIN; A9b catches Fill-suppressed-for-legitimate-types). No findings.
- **Testing**: T7/T8/T9 fixes verified; full A1-A9b inventory mapped to concrete non-vacuous mechanisms; button selectors unambiguous (en titles: "Fill"/"Copy"/"TOTP" — no substring collision); `within` import requirement noted. No findings.

All Recurring Issue Check statuses carried forward unchanged from round 2.

## Go/No-Go

All contracts C1-C4 **locked**. Phase 1 complete after 3 rounds.

---

---

# Round 2

## Changes from Previous Round

All 14 round-1 findings reflected in the plan: search-mode header suppression (I7), explicit no-results condition, `canFill` fill-gating predicate (S1/S2), PASSKEY badge (FR7), rename cascade enumeration, concretized test inventory (A1-A9), extension test command, SC5 scope-out.

## Functionality Findings (round 2)

- **F5 [Minor] (new in round 2)**: pre-existing variable shadow — `displayHost`'s inner `const matched` (MatchList.tsx:152) shadows the outer `matched` list. No runtime impact; file in scope → renamed during helper extraction (plan C2 I10).
- **F11 [Major] (new in round 2)**: plan did not specify whether the "Search results" header renders when `searchResults.length === 0` — A8 had no determinate assertion target. Fixed: I7 now states the header renders whenever `isSearching`, with the no-results message beneath.
- F6 retracted by the expert (urlHost is typed non-nullable); F7-F10, F12 self-resolved during analysis (no bugs: empty-vault search path unreachable by existing design; `sortByUrlMatch(entries, null)` returns fetch order — acceptable; canFill formula already namespaced; shadow covered by F5).
- Verified: I8's behavior-preservation proof confirmed against MatchList.tsx:131-147/218-330 incl. additionalUrlHosts matches, `about:blank` (extractHost → null → nothing renders, canFill false), CREDIT_CARD/IDENTITY in matched list.

## Security Findings (round 2)

- **S1 re-verified CLOSED**: `isHostMatch` (url-matching.ts:17-22) suffix-matches in the safe direction only (`tabHost.endsWith("." + entryHost)`); entry `example.com` vs tab `example.com.evil.net` → false. `canFill` correctly gates.
- **S2 re-verified CLOSED**: `tabHost !== null` short-circuit.
- **SC5 deferral assessed ACCEPTABLE**: the raw `AUTOFILL` handler (background/index.ts:2240) lacks sender validation (popup vs content script) — pre-existing, NOT widened by this PR (content scripts use `AUTOFILL_FROM_CONTENT`, which validates sender; render-time gate preserves the existing model). SC5 extended to include sender validation in the TODO.
- **Cross-domain Copy assessed ACCEPTABLE (no finding)**: user-initiated, clipboard not readable by the page without explicit permission grant, equivalent surface to the web app dashboard.
- **S5 [Minor, Adjacent] (new in round 2)**: `normalizeHost` strips `www.` unconditionally — pathological stored host `www.<tld>` would suffix-match the whole TLD. Pre-existing in an unchanged file; theoretical. → SC6 with TODO marker.

## Testing Findings (round 2)

- **T7 [Critical] (new in round 2)**: A9 as a single two-entry test is a false-positive — screen-scope `queryByRole("button", { name: "Fill" })` matches the CREDIT_CARD's Fill, so "LOGIN row has no Fill" is unverifiable. Fixed: split into A9a/A9b with `within()` row scoping.
- **T8 [Minor] (new in round 2)**: A7's "parity test passes" is necessary but not sufficient (both-keys-missing passes parity). Fixed: A7 now documents that key presence is enforced by A3a/A8 functional assertions.
- **T9 [Minor] (new in round 2)**: PASSKEY fixture title could collide with badge text "Passkey", making `getByText` ambiguous. Fixed: C4 constraint added.
- T1-T5, F4-A resolutions verified correct and complete.

## Resolution Status (Round 2 → plan updates)

| ID | Severity | Resolution |
|----|----------|-----------|
| F5 | Minor | **Fixed in plan** — C2 I10 (rename inner shadow during extraction) |
| F11 | Major | **Fixed in plan** — I7 specifies header renders whenever `isSearching`; A8 updated |
| S5 | Minor | **Skipped (pre-existing, unchanged file)** — Anti-Deferral check: out of scope with [Adjacent] routing + TODO. Worst case: fill offered across a TLD for a pathological stored host `www.<tld>`. Likelihood: very low (no legitimate credential stores a bare TLD). Cost to fix now: changes host-match semantics shared by ALL autofill paths — security carve-out demands its own impact analysis/review. Tracked: SC6 `TODO(extension-search-all-vault): normalizeHost TLD guard`. Orchestrator sign-off: exception satisfied. |
| T7 | Critical | **Fixed in plan** — A9 split into A9a/A9b with `within()` scoping |
| T8 | Minor | **Fixed in plan** — A7 mapping clarified |
| T9 | Minor | **Fixed in plan** — fixture title constraint added |

---

# Round 1

Date: 2026-06-12
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

- **F1 [Major]: Site-context header not suppressed in search mode** — `MatchList.tsx:208-214`: the `{hasTabUrl && ...}` matchesFor/noMatchesFor header renders regardless of search mode; plan must gate it with `!isSearching` (new invariant I7), otherwise "No matches for X" and "Search results" render simultaneously.
- **F2 [Major]: `noResults` empty-state condition not updated for search mode** — `MatchList.tsx:204`: plan removes `filteredMatched`/`filteredUnmatched` without specifying the replacement condition `isSearching && searchResults.length === 0`.
- **F3 [Minor]: PASSKEY rows have no type badge** — `MatchList.tsx:111-119`: `entryTypeBadge()` covers only CREDIT_CARD/IDENTITY; a PASSKEY search result looks like a broken entry. Add `popup.badgePasskey` ("Passkey" / "パスキー") to both locales and the badge function.
- **F4 [Minor]: filteredMatched/filteredUnmatched rename cascade not enumerated** — 10 reference sites; plan must state non-search JSX uses `matched`/`unmatched` directly (TypeScript catches misses at build, so Minor).
- **F4-A [Adjacent → Testing]: duplicate test name** — `MatchList.test.tsx:176,684`: two `it("shows no entries when tabUrl is null (non-web page)")` blocks; pre-existing, file in scope → rename one in this PR (R34).
- R8 note: the "Search results" header must reuse the existing section-header className (`text-xs font-medium text-gray-500 dark:text-gray-400`).

## Security Findings

- **S1 [Major]: Cross-domain LOGIN Fill — NEW exploitation path** — `background/index.ts:1363-1751` (`performAutofillForEntry` has zero host-match check; display suppression is the only gate today), `MatchList.tsx:82-108,126-129`. Post-plan, search mode would render Fill for LOGIN entries of ANY domain: a user on a lookalike domain could search the real entry and inject the real password into the phishing page. Fix adopted: in search mode, suppress Fill for LOGIN entries whose hosts (urlHost + additionalUrlHosts via `isHostMatch`) do not match the current tab — Copy-only row. escalate: false.
- **S2 [Minor]: Fill on chrome:// context silently fails (newly reachable)** — with `tabHost === null` there is no fillable page; suppress Fill for all rows in that state (Copy-only).
- **S3: No finding** — query interpolation in `t("popup.noResults", { query })` is React text-node rendering; escaped by default.
- **S4 [Minor]: PASSKEY username (often an email) visible via search** — pre-existing overview-data exposure class (same as titles/usernames in matched list); vault unlock is a precondition. Accepted (see Resolution Status).

## Testing Findings

- **T1 [Major]: A4 (empty-query unchanged) has no direct test** — add explicit test: empty query → "Matches for {host}" present, "Search results" absent, cross-host LOGIN absent.
- **T2 [Critical]: no-results test is a false-positive guard** — `MatchList.test.tsx:322-340`: fixture makes old and new conditions both true; a stale old condition would still pass. Fix: the A1 regression test must assert the cross-host LOGIN row IS rendered AND the noResults message is NOT rendered (discriminates stale-condition implementations).
- **T3 [Major]: A5 ordering test underspecified** — specify fixture (one tab-matching + one non-matching entry, both matching the query) and DOM-order assertion; otherwise `filterEntries(entries, query)` without `sortByUrlMatch` passes all tests.
- **T4 [Minor]: split A3 into A3a/A3b** — search-mode display-only row vs absent-from-default-view are separate tests.
- **T5 [Minor]: t() key-ordering note** — add i18n keys with/before the tests; missing key makes `t()` return the key path and header assertions fail confusingly.
- **T6-A [Adjacent → Functionality]: PASSKEY fixture shape** — row renders only title/username/host today; minimal fixture is adequate (see Resolution Status for the "future-proof all optional fields" variant).
- Verified facts: extension tests run via `npm test` in `extension/` (root `npx vitest run` does NOT include them — plan must list this explicitly); extension-ci picks up new tests automatically; i18n parity test exists (`i18n.test.ts:55-58`); `EXT_ENTRY_TYPE.PASSKEY` exists (`constants.ts:50`); RT3 — PASSKEY fixture must use the constant, not a string literal; R7 — header assertions must not use `/search/i` (phantom-matches the "Search..." placeholder).

## Adjacent Findings

- F4-A → Testing (duplicate test name; fix in this PR).
- T6-A → Functionality (PASSKEY fixture shape; resolved — minimal shape is correct for current rendering).

## Quality Warnings

None detected by merge-findings.

## Resolution Status (Round 1 → plan updates)

| ID | Severity | Resolution |
|----|----------|-----------|
| F1 | Major | **Fixed in plan** — invariant I7 + implementation note added (C1) |
| F2 | Major | **Fixed in plan** — explicit condition `isSearching && searchResults.length === 0` + forbidden pattern (C1) |
| F3 | Minor | **Fixed in plan** — `popup.badgePasskey` added to C3; badge rendering added to C2 |
| F4 | Minor | **Fixed in plan** — rename strategy enumerated (C1) |
| F4-A | Minor | **Fixed in plan** — test rename added to C4 |
| S1 | Major | **Fixed in plan** — `canFill` predicate added (C1/C2): Fill suppressed in search mode for LOGIN entries not matching the tab host |
| S2 | Minor | **Fixed in plan** — `canFill` requires `tabHost !== null`, covering chrome:// context |
| S4 | Minor | **Accepted** — Anti-Deferral check: acceptable risk. Worst case: shoulder-surfer reads a passkey entry's title/username (often an email) from an unlocked popup the user is actively searching in. Likelihood: low — requires physical proximity, unlocked vault, and an active search by the user. Cost to fix: high relative to benefit (masking usernames in search results cripples the feature's purpose; the same data class is already shown for all other entry types in the matched list). Orchestrator sign-off: acceptable-risk exception satisfied with quantification. |
| T1 | Major | **Fixed in plan** — explicit A4 test specified (C4) |
| T2 | Critical | **Fixed in plan** — A1 test now asserts row rendered AND noResults absent (C4) |
| T3 | Major | **Fixed in plan** — A5 fixture + DOM-order assertion specified (C4) |
| T4 | Minor | **Fixed in plan** — A3 split into A3a/A3b (C4) |
| T5 | Minor | **Fixed in plan** — key-before-test note added (C4) |
| T6-A (future-proof fixture variant) | Minor | **Skipped** — Anti-Deferral check: out of scope (speculative). The row renders only title/username/host; adding unused optional fields to fixtures asserts nothing today (decorative test data). Worst case: a future change renders `relyingPartyId` untested — that change's own review adds the fixture then. Likelihood: low. Cost now: pure speculation with no failing condition. Orchestrator sign-off: acceptable-risk exception satisfied. |

## Recurring Issue Check

### Functionality expert
- R1: Checked — no issue (sortByUrlMatch / filterEntries reused, no reimplementation)
- R2: Checked — no issue (popup.searchResults is an i18n key, not hardcoded literal)
- R3: Checked — no issue (inline-suggestion path correctly scoped out as SC2)
- R4: N/A — no event dispatch
- R5: N/A — no DB writes
- R6: N/A — no data model changes
- R7: Checked — no issue (header is a plain i18n string; existing tests don't query section headers by text)
- R8: Checked — minor gap: plan should specify the "Search results" header uses the same className as existing section headers (text-xs font-medium text-gray-500 dark:text-gray-400)
- R9: N/A — no async tx
- R10: Checked — no issue (no new imports)
- R11: Checked — no issue (search section replaces both sections, not parallel)
- R12: Finding F3 (EXT_ENTRY_TYPE has 4 values; entryTypeBadge covers only 2; PASSKEY now surfaced without badge)
- R13: N/A
- R14: N/A
- R15: N/A
- R16: Checked — no issue (plan mandates vitest + extension build)
- R17: Checked — no issue
- R18: N/A
- R19: Checked — no issue (existing harness/mocks; no shape drift)
- R20: N/A
- R21: N/A — plan review itself
- R22: Checked — no issue
- R23: Checked — no issue (no clamping/validation-on-keystroke; onChange sets query directly)
- R24: N/A
- R25: N/A — query is ephemeral component state
- R26: Checked — no issue
- R27: N/A — no numeric interpolation in new keys
- R28: N/A — header, not toggle
- R29: Checked — no spec citations in plan
- R30: N/A
- R31: N/A
- R32: N/A
- R33: Checked — no issue
- R34: Finding F4-A (duplicate test name, pre-existing, file in scope)
- R35: Checked — no issue (correctly N/A, VE1 documented)
- R36: Checked — no issue (renderEntryRow as plain function avoids nested-component lint issue)
- R37: Checked — no issue ("Search results" / "検索結果" clean)

### Security expert
- R1: Checked — no issue (filterEntries/sortByUrlMatch/isHostMatch reused)
- R2: Checked — no issue
- R3: Checked — no issue (render helper contained to MatchList.tsx)
- R4: N/A — no event dispatch
- R5: N/A — no DB writes
- R6: N/A
- R7: Checked — no issue
- R8: Checked — no issue (plan reuses existing row classNames via helper)
- R9: N/A
- R10: Checked — no issue
- R11: N/A
- R12: Checked — no issue (EXT_ENTRY_TYPE reused; isAutofillable unchanged)
- R13: N/A
- R14: N/A
- R15: N/A
- R16: Checked — no issue
- R17: Checked — no issue
- R18: N/A — no route allowlists changed
- R19: Checked — existing sendMessage mock harness; no new SW messages
- R20: N/A
- R21: N/A
- R22: Checked — attacker perspective considered (S1)
- R23: Checked — no issue
- R24: N/A
- R25: Checked — query is React state only, never persisted to sessionStorage/localStorage/chrome.storage
- R26: Checked — no issue
- R27: N/A
- R28: N/A
- R29: Checked — no spec citations
- R30: Checked — no bare autolink tokens in plan
- R31: N/A
- R32: N/A
- R33: Checked — no issue
- R34: Finding S1 — pre-existing fill-path gap (no host check in performAutofillForEntry) flagged because the plan materially expands its exploitability (security carve-out: must be addressed in-plan, not deferred)
- R35: Checked — correctly N/A (no deployment artifacts)
- R36: Checked — no suppressions
- R37: Checked — no jargon in new strings
- RS1: N/A — no new credential/token comparisons
- RS2: N/A — no new API endpoints (NFR1)
- RS3: Checked — query used only client-side for substring filtering; nothing reaches the server
- RS4: Checked — plan file contains no emails/handles/internal hostnames

### Testing expert
- R1: Checked — no issue
- R2: Checked — see RT3 note (constant vs literal in fixtures)
- R3: N/A — isolated component change
- R4: N/A
- R5: N/A
- R6: N/A
- R7: Checked — phantom-match risk noted: header assertions must not use /search/i regex (matches "Search..." placeholder); use exact text or getByRole
- R8: N/A — out of testing scope
- R9: N/A
- R10: N/A
- R11: N/A
- R12: Checked — EXT_ENTRY_TYPE 4 values; A3 adds PASSKEY coverage
- R13: N/A
- R14: N/A
- R15: N/A
- R16: Checked — root vitest does NOT run extension tests; extension-ci runs `npm test` in extension/; plan must list extension test run explicitly
- R17: N/A
- R18: N/A
- R19: Checked (RT1) — mock shapes match ExtensionResponse/DecryptedEntry
- R20: N/A
- R21: N/A
- R22: N/A
- R23: N/A
- R24: N/A
- R25: N/A
- R26: N/A
- R27: N/A
- R28: N/A
- R29: N/A
- R30: N/A
- R31: N/A
- R32: N/A
- R33: Checked — extension-ci path-gated on extension/**; new tests picked up automatically
- R34: Checked — duplicate test name flagged by Functionality (F4-A); agree it should be fixed in this PR
- R35: N/A — no deployment artifacts
- R36: N/A
- R37: Checked — parity test guards both locales; strings clean
- RT1: Checked — no issue
- RT2: Checked — all planned tests expressible in existing harness
- RT3: Note — PASSKEY fixture must use EXT_ENTRY_TYPE.PASSKEY constant (existing "SECURE_NOTE" literals at 207/370 are a pre-existing inconsistency)
- RT4: N/A — no concurrency tests
- RT5: Checked — planned tests exercise MatchList itself (production filter/sort path)
- RT6: Checked — renderEntryRow is not exported; covered transitively by existing row tests
