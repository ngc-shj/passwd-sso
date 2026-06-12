# Plan: extension-search-all-vault

Date: 2026-06-12 (rev 2: 2026-06-13, post round-1 review)
Branch: `feature/extension-search-all-vault`

## Project context

- Type: web app + browser extension (this change: **extension popup only**)
- Test infrastructure: unit tests (Vitest, jsdom + @testing-library/react for popup components) + integration tests + CI/CD
  - Extension tests are a SEPARATE Vitest project: run via `npm test` inside `extension/` (root `npx vitest run` does NOT include them). CI: `extension-ci` job is path-gated on `extension/**` and picks up new tests automatically.
- Verification environment constraints:
  - **VE1** (`verifiable-local`, manual): real-browser behavior of the popup (Chrome extension loaded unpacked) cannot be exercised by Vitest. All search/filter logic is pure client-side React state and IS unit-testable; only the visual smoke check is manual.
  - No deployment artifacts (Dockerfile, compose, IaC, auth config) are touched → R35 does not fire; no manual-test artifact required. The manual smoke check is listed under Testing strategy for completeness.

## Objective

Make the extension popup's search box search **all vault entries** (every decrypted entry fetched at popup open: personal + team, all entry types), instead of only filtering the entries currently displayed for the active tab — without opening a cross-domain credential-fill path (see C1 `canFill`).

## Background / root cause

The popup already fetches and decrypts ALL entries (`FETCH_PASSWORDS` → `entries` state in `MatchList`). The display pipeline then narrows them:

- `matched` = entries whose `urlHost`/`additionalUrlHosts` match the current tab host ([MatchList.tsx:132-137](../../../extension/src/popup/components/MatchList.tsx#L132-L137))
- `unmatched` = when a tab host exists, only non-LOGIN, non-PASSKEY entries (cards, identities) ([MatchList.tsx:143-147](../../../extension/src/popup/components/MatchList.tsx#L143-L147)); when the page has no host (chrome:// etc.), an empty list
- The search query is applied via `filterEntries()` **to these two display lists only** ([MatchList.tsx:169-170](../../../extension/src/popup/components/MatchList.tsx#L169-L170))

Consequences (the user-reported problem):
1. A LOGIN entry for a different site can never be found by search while on a web page.
2. On non-web pages (chrome://, extension pages) nothing is searchable at all.
3. PASSKEY entries are never visible/searchable in the popup.

No API, service-worker, or crypto change is needed — the data is already in popup memory.

Security constraint discovered in round-1 review (S1): `performAutofillForEntry` ([background/index.ts:1363-1751](../../../extension/src/background/index.ts#L1363-L1751)) performs **no host-match check** — today the popup's display suppression is the only gate preventing a LOGIN credential from being filled into a non-matching page. Search mode must therefore not render Fill for cross-domain LOGIN entries.

## Requirements

Functional:
- FR1: When the search query is non-empty, search across ALL entries in `entries` state — no domain-match exclusion, no entryType exclusion.
- FR2: When the query is empty, rendering is byte-for-byte identical to current behavior (domain-matched section + "Other entries" section with the existing type exclusions).
- FR3: Search-mode results are ordered with current-tab domain matches first (reuse `sortByUrlMatch`).
- FR4: Search matches the same fields as today: `title`, `username`, `urlHost`, `additionalUrlHosts` (case-insensitive substring).
- FR5: Per-row actions in search mode:
  - Fill: rendered only when `canFill(e)` (C1) — autofillable type AND a web-page tab host exists AND (entry is non-LOGIN OR the LOGIN entry's hosts match the tab). Cross-domain LOGIN results are **Copy-only** (S1); on `tabHost === null` no Fill buttons at all (S2).
  - Copy/TOTP: LOGIN entries always (unchanged).
  - PASSKEY and other non-actionable types: display-only rows.
- FR6: Search mode shows a "Search results" section header (same className as existing section headers) and **suppresses** the site-context header (`matchesFor`/`noMatchesFor`/`noMatchesForPage`) and the "Other entries" header while searching.
- FR7: PASSKEY entries get a type badge ("Passkey" / 「パスキー」) so a display-only passkey row is distinguishable from a broken entry.

Non-functional:
- NFR1: No new API calls, no message-protocol change, no change to `DecryptedEntry` shape.
- NFR2: No regression of the 1-minute service-worker entry cache or inline-suggestion path (`GET_MATCHES_FOR_URL`) — untouched.
- NFR3: en/ja message files stay key-parity-complete (guarded by existing parity test [i18n.test.ts:55-58](../../../extension/src/__tests__/lib/i18n.test.ts#L55-L58)).

## Technical approach

Single-component change in `extension/src/popup/components/MatchList.tsx`, plus i18n keys and tests.

- Derive `isSearching = query !== ""` (same truthiness semantics as the current `if (!q)` / `query &&` checks; `trim()` was considered and rejected to preserve exact behavior parity for whitespace queries).
- Search mode: `searchResults = filterEntries(sorted, query)` where `sorted = sortByUrlMatch(entries, tabHost)` (already computed). This is the full entry set.
- Non-search mode: render `matched` / `unmatched` directly. The `filterEntries(matched, query)` / `filterEntries(unmatched, query)` calls and the `filteredMatched` / `filteredUnmatched` variables are deleted; ALL their JSX reference sites (currently lines 204, 211, 218, 220, 273, 277, 279) switch to `matched` / `unmatched` (non-search branch) or `searchResults` (search branch). TypeScript build verifies no stale references remain.
- No-results condition becomes `isSearching && searchResults.length === 0`.
- Header logic: when `isSearching`, render only the "Search results" header (suppress the `hasTabUrl` site-context block and the "Other entries" header).
- Extract the duplicated `<li>` row JSX (currently duplicated verbatim at [MatchList.tsx:220-269](../../../extension/src/popup/components/MatchList.tsx#L220-L269) and [MatchList.tsx:279-328](../../../extension/src/popup/components/MatchList.tsx#L279-L328), differing only in the `li` className) into one render helper used by all three lists (matched, other, search results). With the third consumer this hits the DRY third-duplication threshold.
  - The helper is a plain function inside the `MatchList` component body returning JSX (called as `{list.map((e) => renderEntryRow(e, variant))}`), NOT a nested component — a component defined inside the render function would remount on every render and drop DOM state.
  - `variant: "matched" | "plain"` selects the existing className; search results use `"plain"`.
  - The Fill button render condition inside the helper changes from `isAutofillable(e.entryType)` to `canFill(e)` (C1). In non-search mode this is behavior-preserving (proof in C1 I8).

### Files to update (complete list)

| File | Change |
|------|--------|
| `extension/src/popup/components/MatchList.tsx` | search-mode branch, `canFill` gating, row render helper, header logic, PASSKEY badge |
| `extension/src/messages/en.json` | add `popup.searchResults`, `popup.badgePasskey` |
| `extension/src/messages/ja.json` | add `popup.searchResults` (検索結果), `popup.badgePasskey` (パスキー) |
| `extension/src/__tests__/popup/MatchList.test.tsx` | regression + new behavior tests; rename one of the duplicate test names at lines 176/684 |

Not affected (verified): `extension/src/background/index.ts` (fetch/cache/decrypt/autofill unchanged — the cross-domain gate is enforced at render time, matching the existing display-suppression security model), `extension/src/lib/url-matching.ts` (reused as-is), content scripts (no parallel `.js`/`-lib.ts` pair involved — popup files do not use that pattern), web app, iOS, API routes.

## Contracts

### C1 — Search scope: full entry set, fill-gated

- Signature (derived state/helpers inside `MatchList`, no exported API change):
  - `isSearching: boolean` — `query !== ""`
  - `searchResults: DecryptedEntry[]` — `filterEntries(sortByUrlMatch(entries, tabHost), query)`
  - `filterEntries(list: DecryptedEntry[], q: string): DecryptedEntry[]` — unchanged implementation (fields per FR4)
  - `entryMatchesTab(e: DecryptedEntry): boolean` — `tabHost !== null && (isHostMatch(e.urlHost, tabHost) || (e.additionalUrlHosts ?? []).some((h) => isHostMatch(h, tabHost)))`
  - `canFill(e: DecryptedEntry): boolean` — `isAutofillable(e.entryType) && tabHost !== null && (e.entryType !== EXT_ENTRY_TYPE.LOGIN || entryMatchesTab(e))`
- Invariants (all app-enforced; this is pure client-side view logic, no storage layer can express them):
  - I1: `isSearching === true` ⇒ the rendered result list is derived from the FULL `entries` state — never from `matched`, `unmatched`, or any entryType-excluded subset.
  - I2: `isSearching === false` ⇒ rendered output is identical to the pre-change component (sections, headers, exclusions, ordering, buttons).
  - I3: `entries` state and the service-worker message protocol are not modified.
  - I7: `isSearching === true` ⇒ the site-context header block (`matchesFor`/`noMatchesFor`/`noMatchesForPage`) and the "Other entries" header are NOT rendered; the "Search results" header IS rendered whenever `isSearching`, regardless of whether `searchResults` is empty (the no-results message appears beneath it); the no-results condition is exactly `isSearching && searchResults.length === 0`.
  - I8 (security, S1/S2): a Fill button is rendered for an entry iff `canFill(e)`. Proof of I2-compatibility: in non-search mode, matched-list entries satisfy `entryMatchesTab` by construction; the unmatched list contains only non-LOGIN types and exists only when `tabHost !== null`; when `tabHost === null` no entries render — so `canFill` reproduces current Fill visibility exactly. In search mode it newly suppresses Fill for cross-domain LOGIN entries and for all entries on non-web pages. The fill REQUEST path (`handleFill` → `AUTOFILL` message) is unchanged; render-time gating matches the existing display-suppression security model.
- Forbidden patterns (diff of `MatchList.tsx`):
  - pattern: `filterEntries(matched` — reason: query filtering of the domain-scoped list is the bug being removed
  - pattern: `filterEntries(unmatched` — reason: query filtering of the type-excluded list is the bug being removed
  - pattern: `filteredMatched.length === 0 && filteredUnmatched.length === 0` — reason: stale no-results condition; must be `isSearching && searchResults.length === 0`
- Acceptance criteria:
  - A1 (regression, discriminating per T2): With a tab host present and a query matching a LOGIN entry whose hosts do NOT match the tab, the entry's row IS rendered AND the `popup.noResults` message is NOT rendered. (Fails on current code; also fails on an implementation that keeps the stale no-results condition.)
  - A2 (regression): With `tabUrl = null`, a non-empty query renders matching entries; none of them has a Fill button (I8); Copy is available for LOGIN entries. (Fails on current code, where nothing renders.)
  - A3a: A PASSKEY entry matching the query appears in search results as a display-only row — Passkey badge shown, no Fill/Copy/TOTP buttons.
  - A3b: With an empty query, a PASSKEY entry is absent from the rendered output (default view unchanged).
  - A4: Empty query renders the site-context header ("Matches for {host}") and matched/"Other entries" sections exactly as before; the "Search results" header is absent; cross-host LOGIN entries are absent.
  - A5: With two entries both matching the query — one whose host matches the tab, one not — the tab-matching entry's row precedes the other in DOM order (asserted via `getAllBy*` ordering).
  - A8: With a non-empty query, the "Search results" header is rendered and the site-context header is not (I7); the header remains rendered when `searchResults` is empty, with the no-results message beneath it (the retained existing test `shows no results message when search yields no entries` covers the message itself).
  - A9a: A cross-domain LOGIN search result's row — asserted with `within(<row li>)` scoping — contains Copy and TOTP buttons but NO Fill button (I8).
  - A9b: A CREDIT_CARD search result's row on a web page — asserted with `within(<row li>)` scoping — contains its Fill button (I8). (Separate test from A9a; screen-scope `queryByRole("button", { name: "Fill" })` cannot discriminate which row owns the button when both entries are in one fixture.)
- Consumer-flow walkthrough: the only consumer of `searchResults`/`canFill` is `MatchList`'s own JSX (rows read `{ id, title, username, urlHost, additionalUrlHosts, entryType, teamId, teamName }` to render and to dispatch `handleFill`/`handleCopy`/`handleCopyTotp`, which need `{ id, entryType, teamId }`; `canFill`/`entryMatchesTab` need `{ entryType, urlHost, additionalUrlHosts }` — all present in `DecryptedEntry`). No code outside the component reads the new state; no API/persisted/message shape is defined. No other consumer exists.

### C2 — Row render helper (de-duplication)

- Signature: `renderEntryRow(e: DecryptedEntry, variant: "matched" | "plain"): JSX.Element` — plain function declared inside the `MatchList` body (closure over handlers/`filling`/`displayHost`/`canFill`), not a component.
- Invariants (app-enforced):
  - I4: All three lists (matched, other, search results) render rows through this single helper; the two existing verbatim-duplicated `<li>` blocks are deleted.
  - I5: Rendered DOM for the matched and other lists is unchanged vs. current code (same classNames, same button set per I8, same `key` scheme `` `${e.teamId ?? "personal"}-${e.id}` ``). The "Search results" header uses the existing section-header className (`text-xs font-medium text-gray-500 dark:text-gray-400`).
  - I9: `entryTypeBadge()` gains a PASSKEY case rendering `t("popup.badgePasskey")` (style consistent with the existing Card/Identity badges).
  - I10 (pre-existing cleanup, file in scope): the inner `const matched` inside `displayHost` ([MatchList.tsx:152](../../../extension/src/popup/components/MatchList.tsx#L152)) shadows the outer `matched` list — rename it (e.g., `additionalMatch`) while extracting the helper; behavior unchanged.
- Forbidden patterns:
  - pattern: `const EntryRow` — reason: nested component declaration inside `MatchList` would remount per render; the contract is a render function, and a module-level component is out of scope churn
- Acceptance criteria:
  - A6: Existing rendering/action tests (fill, copy, TOTP, badges) pass without weakening assertions.

### C3 — i18n keys

- Shape: added to both `extension/src/messages/en.json` and `extension/src/messages/ja.json`:
  - `popup.searchResults` — "Search results" / "検索結果"
  - `popup.badgePasskey` — "Passkey" / "パスキー"
- Invariants (app-enforced): I6: en.json and ja.json key sets remain identical — enforced by the existing parity test (`keeps key sets aligned between locales`, [i18n.test.ts:55-58](../../../extension/src/__tests__/lib/i18n.test.ts#L55-L58)).
- Forbidden patterns:
  - pattern: `ボルト` — reason: ja translations must use 保管庫, never katakana (project convention)
- Acceptance criteria:
  - A7: Both locale files contain both keys; no internal jargon in either string (R37); parity test passes. Note: the parity test enforces en↔ja SYMMETRY only (both-missing passes it); key PRESENCE is enforced by the A3a/A8 functional assertions, which fail if `t()` returns the key path instead of the real string.

### C4 — Tests

- Location: `extension/src/__tests__/popup/MatchList.test.tsx` (existing file, existing harness/mocks; `@vitest-environment jsdom` docblock already present).
- Test inventory (one behavioral assertion per test):
  - A1, A2 written first as regression tests — confirmed to FAIL against the pre-change component before implementing.
  - A3a, A3b, A4, A5, A8, A9a, A9b as specified in C1/C2 (A9a/A9b use `within()` from @testing-library/react for row-scoped button assertions).
  - Existing tests `filters entries by search query` and `shows no results message when search yields no entries` remain; their semantics stay valid under search-all (verified in round-1 review).
- Test-quality constraints:
  - Fixtures use `EXT_ENTRY_TYPE.*` constants, never string literals (RT3; do not replicate the pre-existing `"SECURE_NOTE"` literals at lines 207/370).
  - PASSKEY fixture uses the minimal `DecryptedEntry` shape (`id`, `title`, `username`, `urlHost`, `entryType`) — the row renders only title/username/host today. The fixture `title` must NOT equal the badge text ("Passkey") to avoid `getByText` ambiguity between badge and title.
  - Header assertions use exact text (or role-scoped queries), never `/search/i`-style regexes — the "Search..." input placeholder would phantom-match (R7).
  - i18n keys (C3) are added in the same change-set as (or before) the tests so `t()` resolves real strings, not key paths (T5).
  - Rename one of the two duplicate `it("shows no entries when tabUrl is null (non-web page)")` blocks (lines 176/684) to a unique description (F4-A; pre-existing, file in scope).
- Acceptance criteria: all tests above implemented and passing; A1/A2 demonstrated failing pre-change.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Search scope: full entry set, fill-gated (`canFill`) | locked |
| C2 | Row render helper + PASSKEY badge + shadow rename | locked |
| C3 | i18n keys (en/ja `popup.searchResults`, `popup.badgePasskey`) | locked |
| C4 | Tests (A1-A9b inventory + quality constraints) | locked |

## Testing strategy

- Unit (Vitest, existing harness in `MatchList.test.tsx` with mocked `sendMessage`): the C4 inventory. A1/A2 written first to confirm they fail on current code.
- Extension suite: `npm test` in `extension/` (root `npx vitest run` does NOT include extension tests).
- Full root suite: `npx vitest run` (mandatory check).
- Build: `npx next build` (mandatory check) + extension build (`npm run build` in `extension/`) since the change is extension code and the root Next build does not compile the extension.
- Manual smoke (VE1, non-gating): load unpacked extension; on a site with one matched entry, search a different site's LOGIN entry → appears Copy-only (no Fill); on `chrome://extensions` search returns results with no Fill buttons; empty query view unchanged.

## Considerations & constraints

- Search fields stay at the 4 overview fields; the extension's `DecryptedEntry` carries no more searchable data (unlike the web app's 15+ fields, which come from a richer overview shape).
- Entries snapshot is what was fetched at popup open (existing behavior; unchanged).
- Performance: linear filter over all entries per keystroke, same complexity class as today (the full set is already in memory and already sorted once per render). No memoization added (the component currently filters inline without `useMemo`; matching existing style, list sizes are popup-scale).
- Accepted risk (S4, quantified in review round 1): PASSKEY titles/usernames (often emails) become shoulder-surfable via search in an unlocked popup — same exposure class as existing matched-list rendering; masking them would cripple the feature.

### Scope contract

| ID | Deferred item | Owner / tracking |
|----|---------------|------------------|
| SC1 | Searching additional fields (notes snippet, card brand, etc.) — requires enriching the extension overview payload shape across app+extension(+iOS AAD parity) | Future feature; not tracked by an issue yet — out of this PR by design |
| SC2 | Inline-suggestion matching (`GET_MATCHES_FOR_URL` / content-script dropdown) — remains domain-scoped by design (an in-page dropdown must stay site-relevant) | Intentionally unchanged behavior |
| SC3 | Server-side search / pagination for very large vaults | Not needed — full fetch already exists; revisit only if fetch strategy changes |
| SC4 | Web-app search behavior | Already full-vault; untouched |
| SC5 | Host-match enforcement inside `performAutofillForEntry` AND sender validation on the raw `AUTOFILL` message handler (the handler does not distinguish popup vs content-script senders — pre-existing, verified in round-2 review; not widened by this PR) | `TODO(extension-search-all-vault): SW-layer host check + AUTOFILL sender validation` — follow-up; render-time gating preserves the existing security model in this PR, and the SW change touches the shared autofill path used by inline suggestions (separate risk surface requiring its own review) |
| SC6 | `normalizeHost` strips `www.` unconditionally ([url-matching.ts:13-15](../../../extension/src/lib/url-matching.ts#L13-L15)) — an entry stored with `urlHost = "www.<tld>"` would suffix-match any host under that TLD. Pre-existing, in an UNCHANGED file; theoretical (no legitimate credential stores a bare TLD host). Worst case: credential fill offered across a TLD for a pathological stored host. Likelihood: very low. Cost to fix here: touches host-matching semantics shared by all autofill paths — needs its own review | `TODO(extension-search-all-vault): normalizeHost TLD guard` — follow-up |

## User operation scenarios

1. **Cross-site lookup while on a site**: User is on `github.com`; popup shows the GitHub entry under "Matches for github.com". They type "aws" → the AWS LOGIN entry (different host) appears under "Search results" with Copy/TOTP but no Fill; Copy password works. (Currently: no results.)
2. **Search from a non-web page**: User opens the popup on `chrome://extensions` and types "bank" → matching entries appear, Copy-only. (Currently: the popup shows nothing and search is dead.)
3. **No behavior change without a query**: User on `github.com` opens the popup and types nothing → GitHub matches on top, cards/identities under "Other entries", other sites' logins hidden — exactly as today.
4. **Passkey discoverability**: User types the name of a passkey-only entry → it appears as a display-only row with a "Passkey" badge (no Fill/Copy), confirming the credential exists; actual passkey use still goes through the WebAuthn interceptor.
5. **Query matching both scopes**: On `github.com`, query "git" → the matched GitHub entry sorts first (with Fill), followed by e.g. a "GitLab" entry for another host (Copy-only), in one "Search results" list.
6. **Anti-phishing guard**: User is lured to `accounts-google.com.evil.example` and searches "google" → the real Google entry appears but offers no Fill button; the user cannot one-click-inject credentials into the lookalike page.
