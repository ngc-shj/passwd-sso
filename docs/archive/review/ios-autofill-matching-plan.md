# Plan: iOS AutoFill — fix blank list (iOS 17+ methods) + matched-only picker with search

## Project context
- Type: `mixed` — native iOS app; this change is in the AutoFill credential-provider extension and
  the Shared framework (security-sensitive: it governs which decrypted credential summaries are
  shown for filling).
- Test infrastructure: `unit tests only` (PasswdSSOTests; logic-level incl. URLMatchingTests). The
  `resolveCandidates` filtering/return-shape IS unit-testable with in-memory fakes; the iOS
  credential-provider method routing is NOT unit-testable (UIKit/ASCredentialProvider internals) and
  is verified on-device (already done — see Evidence).

## Evidence (on-device, iOS 18/26, confirmed before this plan)
- iOS calls **`prepareCredentialList(for:requestParameters:)`** (iOS 17+ variant), NOT the legacy
  `prepareCredentialList(for:)`. The extension only overrode the legacy method → no prepare ran →
  `viewDidLoad/viewWillAppear/viewDidAppear` fired but the picker was **blank** ("0 candidates").
  This was misread as a host-matching bug; matching is correct.
- With a delegating override added, the list populated: `allEntries=417 decryptedSummaries=417`,
  page `serviceIdentifier raw=https://www.amazon.co.jp/ap/signin?...`, `tabHosts=[amazon.co.jp]`,
  and the amazon entry `urlHost='www.amazon.co.jp' -> match=true`. Matching works.
- `resolveCandidates` returns `matched + unmatched` = all 417 entries → the picker shows everything,
  including empty-host and unrelated entries ("URL mismatch entries also appear").
- Deployment target is iOS 17.0, so iOS ALWAYS calls the iOS 17+ method variants; the legacy
  `ASPasswordCredentialIdentity`-based overrides are dead code on every supported device.

## Objective
1. (#2) Make the credential list actually appear by overriding the iOS 17+ method variants iOS
   actually calls.
2. (#3) Show only host-matched entries by default; provide a search field to reach any entry
   (user-approved policy: matched-only + search; empty when no match, search browses all).
3. Remove all temporary `AFDIAG` diagnostics and now-dead legacy overrides.

## Requirements
Functional:
- Selecting passwd-sso as the AutoFill provider shows host-matched entries (not blank, not all).
- A search field filters across ALL entries (title / username / urlHost, case-insensitive).
- Single-credential fill and TOTP fill continue to work via the iOS 17+ methods.
- No behavior change to crypto/decrypt; only which summaries are surfaced + which iOS methods are
  implemented.

Non-functional:
- No `AFDIAG`/diagnostic logging or dead legacy overrides remain in the diff.
- Matching logic (`isHostMatch`, `extractHost`, `normalizeHost`) is UNCHANGED — it is correct
  (confirmed on-device). Do not touch URLMatcher.

## Contracts

### C1 — iOS 17+ credential-provider method overrides (locked)
- `CredentialProviderViewController` overrides, as the real entry points:
  - `prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier], requestParameters: ASPasskeyCredentialRequestParameters)` (iOS 17+) → delegates to the shared password-list presentation.
  - `provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest)` (iOS 17+) → cancel with `userInteractionRequired` (per-fill biometric is mandatory).
  - `prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest)` (iOS 17+) → decrypt `credentialRequest.credentialIdentity.recordIdentifier` and complete.
  - keep `prepareCredentialList(for serviceIdentifiers:)` as the shared implementation (entry point on any iOS that still calls it; called by the requestParameters override).
  - keep `prepareOneTimeCodeCredentialList(for:)`.
- Remove the legacy `provideCredentialWithoutUserInteraction(for: ASPasswordCredentialIdentity)` and
  `prepareInterfaceToProvideCredential(for: ASPasswordCredentialIdentity)` overrides (dead on iOS
  17.0+ deployment target).
- Acceptance: on-device, selecting the provider shows the list (already verified with the delegating
  override); single-credential + TOTP fill complete. Build clean.
- Forbidden patterns:
  - `pattern: AFDIAG` — reason: all diagnostic logging must be removed.
  - `pattern: ASPasswordCredentialIdentity` — reason: the legacy identity-based method overrides are
    removed; the iOS 17+ ASCredentialRequest path supersedes them (ASPasswordCredential — the fill
    result type — is still allowed; this forbids the *Identity* override params).

### C2 — resolveCandidates returns matched + all (locked)
- `CredentialResolver.resolveCandidates(for:)` returns a `CandidateResult` value:
  - `struct CandidateResult: Sendable { let matched: [VaultEntrySummary]; let all: [VaultEntrySummary] }`
  - `matched` = host-matched summaries (current `matched` set). `all` = `matched + unmatched`
    (matched-first ordering preserved, for search display).
- The matching computation (`isHostMatch` over `tabHosts`) is unchanged; only the return shape and
  the removal of the `matched + unmatched` flattening at the call boundary.
- All `AFDIAG` logging in CredentialResolver is removed (and the `#if DEBUG import os` block).
- **Consumer-flow walkthrough**:
  - Consumer `CredentialProviderViewController.prepareCredentialList` reads `{ matched, all }` and
    passes both to `CredentialPickerView` (matched for the default view, all for search).
  - Consumer `CredentialProviderViewController.prepareOneTimeCodeCredentialList` reads `{ matched, all }`
    and filters each by `hasTOTP` before passing to `OneTimeCodePickerView`.
  - No consumer needs a field absent from `CandidateResult`.
- Acceptance: unit test — given summaries where some host-match and some do not, `matched` contains
  exactly the matched ones and `all` contains every decrypted summary with matched ones first.
- Forbidden patterns:
  - `pattern: return matched + unmatched` — reason: the all-entries flattening is what caused #3.

### C3 — Picker shows matched-only + search across all (locked)
- `CredentialPickerView`: props become `matched: [VaultEntrySummary]`, `all: [VaultEntrySummary]`
  (plus existing serviceIdentifiers/onSelect/onCancel). `@State searchText`.
  - searchText empty → display `matched`. Empty `matched` → empty state "No passwords for this site"
    (with hint that search browses all).
  - searchText non-empty → display `all` filtered by case-insensitive contains on title, username,
    or urlHost. No results → "No matches".
  - `.searchable(text: $searchText, prompt: "Search all entries")`.
- `OneTimeCodePickerView`: same `matched`/`all` + search pattern (entries already TOTP-filtered by the
  controller).
- App-side confirmation sheet (bundle-ID requests) behavior is preserved.
- Acceptance: build clean; on-device, default view shows only host matches, typing in search reaches
  any entry. (Geometry/interaction is manual; the filter predicate is small enough to keep inline.)

### C4 — No regression (locked)
- `xcodegen generate` + `build-for-testing` + `test-without-building` pass; existing 233 unit + 2 UI
  tests stay green, plus new CredentialResolver tests (C2). No new warnings (warnings-as-errors).

## Testing strategy
- Unit: new `CredentialResolverTests` (or extend existing) for C2 — the matched/all split using
  in-memory `BridgeKeyStore`/`WrappedKeyStore` fakes and a synthesized cache, OR if full resolver
  setup is too heavy, factor the pure matching/partition step into a testable free function and test
  that directly (preferred — keeps the test at logic level). URLMatchingTests already cover
  `isHostMatch`/`extractHost`/`normalizeHost` (unchanged).
- Picker search predicate: if extracted to a pure function, unit-test it; otherwise manual.
- On-device method routing (#2): already verified; not unit-testable. Manual re-confirm after cleanup.

## Considerations & constraints
- **QuickType inline bar still empty (separate gap, OUT of scope)**: no `ASCredentialIdentityStore`
  registration exists, so the inline keyboard suggestion bar shows nothing — only the manual provider
  picker is fixed here. Tracked as a follow-up (`TODO(ios-autofill-quicktype)`): register
  `ASPasswordCredentialIdentity` entries on host-app sync. NOT included now to keep this PR focused on
  the confirmed blank-list + over-matching fixes. (30-min rule N/A: identity registration is a
  non-trivial host-app sync change with its own threat-model review.)
- Removing legacy overrides: safe because deployment target is iOS 17.0 (the new variants are always
  called). If the reviewer wants belt-and-suspenders, the legacy overrides may be kept as no-op
  delegators, but default is removal (no dead code).
- The picker now holds the full decrypted summary set in memory for search — this is unchanged from
  today (it already received all 417); no new exposure.

## User operation scenarios
- amazon login field → select passwd-sso → see only the amazon entry (and other amazon matches).
- A site with no stored entry → empty "No passwords for this site" → type in search → find any entry.
- TOTP field → see only host-matched entries that have TOTP.

## Round 1 Review Resolutions (triangulate — functionality/security/testing)

- **T1/F1 (High/Major) → FIXED in spec**: changing `resolveCandidates` to return `CandidateResult`
  source-breaks ~12 existing test call sites (CredentialResolverTests.swift: 459,773-775,806-809,
  848-850,886-888,940-941,994-995; DebugVaultLoaderTests.swift: 65-67,78-80,130-135,145,151). C4's
  "stay green" requires MIGRATING them, not leaving them. Decision:
  1. Extract a **pure free function** `partitionCandidates(_ summaries: [VaultEntrySummary], tabHosts:
     [String]) -> CandidateResult` in Shared (the matching loop is already pure given summaries +
     tabHosts). `resolveCandidates` calls it and returns `CandidateResult`.
  2. Migrate the ~12 existing callers: mechanical `candidates` → `result.all` (semantics identical:
     `all == matched + unmatched` = old return). EXCEPT the host-filter integration test
     `testResolveCandidates_filtersByURLHost` (CredentialResolverTests.swift:386-472) which is
     **rewritten (not just redirected)** to assert BOTH `result.matched.map(\.id) == ["entry-1","entry-2"]`
     AND `result.all.count == 3 && result.all.last?.id == "entry-3"` (T4).
- **T2 → FIXED**: new C2 tests run against the pure `partitionCandidates` (no crypto fixtures). Five
  cases: (1) matched non-empty + matched-first ordering; (2) matched empty → `all == summaries`;
  (3) ordering stable with ≥2 matched + ≥2 unmatched; (4) empty-`urlHost` entry → matched-EXCLUDED
  but present in `all` (asserts `isHostMatch("",…)` is not a wildcard); (5) empty `tabHosts` →
  matched empty, `all == summaries`. One behavioral assertion per test.
- **T3/F6 → FIXED**: extract a pure shared predicate `summaryMatchesSearch(_ summary:, query:) -> Bool`
  (case-insensitive OR over title/username/urlHost), used by BOTH pickers (DRY), unit-tested
  (~5 cases incl. case-insensitivity and urlHost match). Empty/whitespace query → caller shows
  `matched` (the view branches before calling).
- **F4 (Major) → FIXED in C3**: replace the single `candidates.isEmpty` branch with a computed
  `displayed` list and THREE empty states: (a) search empty + matched empty → "No passwords for this
  site" (+ hint search browses all); (b) search non-empty + filtered empty → "No matches"; (c) has
  rows. Search-result selection MUST route through the existing `handleSelection` (app-side bundle-ID
  confirmation-sheet gate) — not a new direct `onSelect`.
- **F3 (Minor) → FIXED in C1**: `prepareInterfaceToProvideCredential(for: any ASCredentialRequest)`
  guards request type — only handle password requests; cancel a passkey request explicitly (no
  wrong-type completion). `credentialRequest.credentialIdentity.recordIdentifier` is valid on the
  protocol (no force-unwrap; already nil-coalesced).
- **F2 (Major) → RESOLVED by on-device evidence**: the list override param type
  `ASPasskeyCredentialRequestParameters` is empirically the variant iOS 18/26 calls (the device log
  showed `prepareCredentialList(requestParameters) invoked` and the list populated). Keep it; the body
  ignores the params and delegates to `prepareCredentialList(for:)`. (Expert reasoned from API memory;
  the device is authoritative.)
- **F5/T5 (Major) → DOCUMENTED + mitigated**: `hasTOTP` comes from the overview blob and is
  unreliable (DebugVaultLoaderTests.swift:147-156 documents it as always-false for legacy/fixture
  overviews). With matched-only, the TOTP picker's matched set can be empty even when host-matched
  TOTP entries exist. Mitigation: the TOTP picker's SEARCH path filters `all` WITHOUT the `hasTOTP`
  gate (so a mis-flagged entry is still reachable; `completeTOTPFill` already guards on
  `detail.totpSecret`). The matched DEFAULT keeps the `hasTOTP` gate (no regression vs today). Full
  fix (write `hasTOTP` into the overview) is a named follow-up `TODO(ios-autofill-hastotp)`, NOT this
  PR.
- **S1 (Low) → FIXED**: remove ALL `AFDIAG` statements AND both `#if DEBUG import os`/`Logger(...)`
  blocks. The forbidden-pattern grep MUST also cover the lifecycle diagnostics
  (`viewDidLoad`/`viewWillAppear`/`viewDidAppear`/`prepareInterfaceForExtensionConfiguration`), not
  only the credential-flow methods. Acceptance: zero `Logger`/`os_log`/`AFDIAG` in
  `ios/Shared/AutoFill/` and `ios/PasswdSSOAutofillExtension/`. Biometric gate confirmed intact;
  passwords/TOTP secrets never logged.
- **Security follow-up note**: when the QuickType `ASCredentialIdentityStore` registration lands
  (`TODO(ios-autofill-quicktype)`), identities MUST be cleared on vault lock / logout / travel-mode
  (stale username/URL hints otherwise persist in the system store). Captured for that PR's threat model.

## Go/No-Go Gate
| ID  | Subject                                              | Status |
|-----|------------------------------------------------------|--------|
| C1  | iOS 17+ method overrides (fix blank list)            | locked |
| C2  | resolveCandidates returns matched + all              | locked |
| C3  | Picker matched-only + search                         | locked |
| C4  | No build/test regression                             | locked |
