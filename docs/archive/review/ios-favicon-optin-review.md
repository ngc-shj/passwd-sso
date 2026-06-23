# Plan Review: ios-favicon-optin
Date: 2026-06-23
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

### F1 — Major: FR-6 (`EntryDetailView` header icon) is architecturally infeasible as described
- File: EntryDetailView.swift:55-69
- The header is `.navigationTitle(summary.title)` + `.inline` + a single trailing Edit `ToolbarItem`. There is no leading/principal area to embed a SwiftUI view. Plan must specify a concrete placement: (a) `.principal` ToolbarItem with `HStack(icon+title)` (changes Edit-button layout/a11y), or (b) a top `Section` in the detail `List` with a centered `EntryIconView`. Update C4 walkthrough accordingly. Cannot lock C4 until resolved.

### F2 — Major: C7 `@AppStorage` reactivity — list containers not listed, C5 signature contradiction
- File: VaultListView.swift:9-34, 341; VaultCategoryLanding.swift:56-67, 98
- The list containers have no `@AppStorage` today (only `appTheme` exists app-wide at PasswdSSOAppApp.swift:20). For FR-4 live re-render, the list container must hold `@AppStorage("showFavicons", store: .appGroup)` and pass a `Bool` down. `AppSettingsStore` is a plain struct (not `@Observable`), so a direct `AppSettingsStore().showFavicons` read inside a row body is NOT reactive. C5 signature `let summary` is then contradictory — the row needs `let showFavicons: Bool` too. Add both list files to §Pieces; update C5 signature.

### F3 — Major: `URLCache.shared` is NOT the cache `AsyncImage` uses — sign-out clear silently ineffective
- File: (plan NFR-2/Caching design + C8); AsyncImage uses a private internal URLSession/cache, not URLSession.shared/URLCache.shared
- The plan's "AsyncImage + clear URLCache.shared" is internally contradictory: AsyncImage's cache is isolated and not API-clearable. NFR-3/C8 (R39 clear-on-sign-out) cannot be met this way. Either (A) abandon AsyncImage for a custom URLSession-backed image view with a dedicated URLCache (un-defer SC4 — it is REQUIRED, not optional), or (B) explicitly weaken NFR-3 to best-effort and document residual risk. **Converges with S1 and T1.**

### F4 — Minor: cross-reference `testAllCasesCountIsEight` guard in C2
- File: EntryTypeCategoryTests.swift:30-31
- rowSymbol is a computed property (count stays 8). Add a note to C2 so reviewers know this test is the guard against an accidental new-case addition.

### F5 — Minor: §Pieces omits `VaultListView` / `VaultCategoryListView` as changed files
- File: VaultListView.swift:341, VaultCategoryLanding.swift:98 (both call `EntrySummaryRow(summary:)`)
- Add both to the changed-files manifest with their specific changes (precondition for a meaningful go/no-go gate).

## Security Findings

### S1 — Major: `URLCache.shared` on-disk data not deleted on sign-out — host metadata persists after session end
- File: AutoLockService.swift:107-110 (signOut removes App-Group vault dir only); AppGroupContainer.swift:27-29
- `signOut()` deletes `<container>/vault/`, but `URLCache.shared` lives in `~/Library/Caches/<bundle-id>/` — NOT deleted. Cache keys are URLs of form `https://icons.duckduckgo.com/ip3/<host>.ico`, so the cache reconstructs the full stored-service host list. Recoverable via forensic/backup read post-sign-out. Undermines NFR-3/R39. Fix: dedicated `URLCache(directory:)` inside the App-Group vault dir that `signOut()` already deletes, plus a physical `removeItem(at:)`. **Promote SC4 from deferred to pre-merge.** escalate: false.

### S2 — Minor: IP literals / mDNS / localhost not blocked in C1 — leaks internal topology to DuckDuckGo
- File: (plan C1 invariants/acceptance)
- C1's "illegal host-label characters" does not reject IPv4 literals (`192.168.1.1`), `.local`, `localhost`. When opted in, these produce valid requests disclosing LAN/internal service names. Add to C1 nil-return: IPv4/IPv6 literals, `.local` suffix, `localhost`. (They have no meaningful favicon anyway.)

### S3 — Minor: `@AppStorage` key drift — `private` Key enum prevents compile-time enforcement
- File: AppSettingsStore.swift:62-69 (Key is `private`)
- Drift direction is fail-closed (safe), but the only guard is a test. Expose `Key.showFavicons` as `internal`/`public` (or a shared public constant) so the `@AppStorage` literal references a named constant at compile time, not a string. **Interacts with F2/T2.**

### S4 — Minor: `PrivacyInfo.xcprivacy` `NSPrivacyCollectedDataTypes` empty despite sending domain names to a third party
- File: PasswdSSOApp/PrivacyInfo.xcprivacy:10
- URLSession API-reason exemption is correct, but the collected-data-type declaration is separate. Domain names sent to DuckDuckGo are browsing-history-adjacent. Add an `NSPrivacyCollectedDataTypeBrowsingHistory` entry (Linked=false, Tracking=false, Purpose=AppFunctionality). Resolve before App Store submission regardless. Plan's "no manifest change required" is disputed.

### S5 — Minor: third-party image bytes decoded by ImageIO — theoretical decoder exploit surface (RS5)
- File: (plan C4 AsyncImage)
- Bytes decoded by ImageIO; not used in any trusted/crypto context. Low risk; `https`-only invariant (C1) mitigates passive MITM. Acceptable for v1 — document as known accepted risk; SC1 proxy eliminates it later.

## Testing Findings

### T1 — Major: C8 cache-clear test infeasible — no injectable seam on `AutoLockService`
- File: AutoLockService.swift:44-62 (constructor has no cache-clear param), :100-112 (signOut); AutoLockServiceTests.swift:327-366 (SpyTeamDirectoryStore DI pattern to mirror)
- `URLCache.shared`/`FaviconLoader.shared` are globals with no injection point. The proposed "called exactly once" assertion has nothing to spy on. Add `faviconCacheClearing: @escaping () -> Void = { ... }` to `AutoLockService.init` (mirror the `teamDirectoryStore` spy). Then test signOut-calls / lock-does-not. **Converges with F3/S1.** Until fixed, VEC-2 "verifiable-local wiring" is unsubstantiated.

### T2 — Major: C7 key-drift unit test cannot catch the drift it claims (RT7)
- File: AppSettingsStore.swift:63-69 (`private enum Key`), :167-170 (autoCopyTotp reads via `defaults.bool`, not @AppStorage)
- A `View`'s `@AppStorage("...")` literal is not introspectable from XCTest; asserting `Key.showFavicons == "showFavicons"` only pins the constant, not the View literal. Resolution: (A) have the row/container read `AppSettingsStore().showFavicons` directly (no `@AppStorage` literal) — drift gone, but then F2's reactivity must be solved another way (e.g. pass a `Bool` resolved at the unlocked-list boundary and re-resolved on `scenePhase`/sheet dismissal); or (B) keep `@AppStorage` and reclassify the drift guard as a Phase-3 grep/code-review step (remove the unit-test claim). **Interacts with F2/S3.**

### T3 — Minor: C4 decision matrix missing 5th case (non-LOGIN + showFavicons=false)
- File: (plan C4 acceptance)
- Invariant prose covers "regardless of showFavicons" but the 4-row matrix omits it. Add: non-LOGIN, showFavicons false → `.symbol(<type glyph>)`.

### T4 — Minor/No-action: C2 symbol-name validity correctly deferred to manual
- File: (plan C2)
- Confirming: unit-test the string values + non-emptiness; SF Symbol name validity needs `UIImage(systemName:)` (UIKit host) → manual VEC-1. Classification sound. No action.

## Adjacent Findings
- S3 tagged [Adjacent → Functionality/Testing] (key exposure interacts with F2/T2 propagation design).
- F2/F3 tagged implicitly adjacent to Testing (T1/T2 depend on the architectural choices in F2/F3).

## Quality Warnings
None — all findings carry file:line evidence and concrete fixes.

## Convergence Note (orchestrator)
The single most important signal: **F3 = S1 = T1** — three experts, three lenses, one root cause: `AsyncImage` + `URLCache.shared` cannot satisfy NFR-3 (R39 clear-on-sign-out) and cannot be unit-tested. This forces **un-deferring SC4** (dedicated `URLCache` in an app-controlled directory) as a pre-merge requirement, which simultaneously: (a) makes the cache clearable (S1/F3), (b) makes it injectable/testable (T1), and (c) requires a custom URLSession-backed image view instead of `AsyncImage` (F3). This one decision resolves the three Major findings together. **F2 + T2 + S3** form a second cluster around the opt-in flag's reactive propagation and key drift.

## Recurring Issue Check
### Functionality expert
- R1 (image/favicon helper exists?): Checked — none (grep clean). No reuse miss.
- R2 (showFavicons key duplicated as @AppStorage literal): Checked — plan flags it; impl risk (see F2/S3).
- R3–R7: N/A (no DB/API/auth-flow/server patterns).
- R8 (UI consistency category vs row badge): Checked — plan uses same filled-badge idiom; Phase 3 verifies.
- R9–R24: N/A (backend patterns; SSRF guard is SC1-deferred).
- R25 (persist/hydrate symmetry of showFavicons): Checked — C3 mirrors autoCopyTotp; round-trip in acceptance.
- R26 (no blank icon): Checked — C4 fallback to globe on every non-success path.
- R27–R38: N/A (no webhook/SCIM/extension network patterns).
- R39 (favicon cache clear on lifecycle): Finding F3.
- R40–R41: N/A.

### Security expert
- R1 (input validation at boundary): Finding S2.
- R2 (SSoT for keys): Finding S3.
- R3 (fail-closed defaults): Checked — C3 correct (defaults.bool → false).
- R4: N/A (no server handler). R5: Checked (no urlHost logging). R6: N/A (no new deps). R7: N/A.
- R8: N/A. R9–R15: N/A. R16 (TLS pinning): Checked — DuckDuckGo uses default trust store, consistent.
- R17–R18: N/A. R19 (SSRF server-side): N/A; client-side → S2. R20 (deserialization): S5 (minor).
- R21–R23: N/A. R24 (background snapshot): Checked — existing blur covers list (PasswdSSOAppApp.swift:58-63).
- R25 (settings persistence): S3-adjacent (drift not symmetry). R26: Checked.
- R27: Checked (host ASCII/punycode; C1 rejects illegal chars). R28 (data minimization): S4.
- R29 (Keychain shared): Checked — favicon cache not in Keychain. R30: Checked. R31: Checked (signOut clear direction).
- R32: N/A. R33: Checked. R34 (offline): Checked — globe fallback. R35: Checked (VEC plans).
- R36: N/A (no new entitlements; SC3). R37 (jargon): Checked — footer names DuckDuckGo. R38 (concurrency): Checked.
- R39 (lifecycle zeroization): Finding S1. R40: N/A. R41 (privacy manifest): Finding S4.
- RS1 (secrets): Checked — DuckDuckGo unauthenticated. RS2 (supply chain): Checked — no deps.
- RS3 (3rd-party SDK collection): S4-related. RS4 (PII in crash/analytics): Checked — no urlHost to reporters.
- RS5 (untrusted external param): S5 (minor) — bytes display-only, not in trusted context.

### Testing expert
- R1: T2-related (SSoT enforcement mechanism wrong). R2: T2. R3–R24: N/A (no migration/crypto/RBAC/SCIM).
- R25 (persist/hydrate): Checked — C3 mirrors autoCopyTotp tests (AppSettingsStoreTests.swift:163-182).
- R26 (no blank icon): Checked — decision() globe fallback. R27–R38: N/A.
- R39 (cache clear on sign-out): Finding T1. R40–R41: N/A.
- RT1 (mock-reality): Checked — FaviconProvider returns real URL; no mock shapes.
- RT2 (testability): Checked — SwiftUI/AsyncImage correctly classified non-unit-testable; pure seams testable.
- RT3: N/A. RT4 (race vacuous): N/A (no concurrency). RT5 (test call-path includes primitive): Finding T1.
- RT6 (new exports tested): Checked — each testable export mapped; EntryIconView via decision() seam (T3 minor gap).
- RT7 (prove gate can fail): Finding T2 (C7 drift test cannot fail for its claimed reason).

---

# Plan Review: ios-favicon-optin — Round 3 (confirmation)
Date: 2026-06-24
Review round: 3

## Changes from Previous Round
Applied round-2 fixes. Round 3 was a focused internal-consistency / regression pass on the round-2 deltas.

## Findings (round 3)
- F11 (Major): NFR-2 still prescribed the REJECTED "AsyncImage + shared URLCache" approach (stale summary not updated when the decision changed) → FIXED: NFR-2 now points to FaviconLoader/FaviconImageView + dedicated cache; "never AsyncImage/URLCache.shared".
- F12 (Major): Testing strategy + C7 acceptance still named the tautological `faviconShowKey == "showFavicons"` test that C3 body explicitly rejects (T5) → FIXED: both now reference the behavioral key-consistency test.
- Propagation sweep (R3): grepped the whole plan — every remaining AsyncImage/URLCache.shared mention is a forbidden-pattern entry or a rationale/correction note; the only `faviconShowKey == "showFavicons"` left is C3's text explaining WHY that form is wrong; `defense-in-depth` appears only in the correction note. No other stale instances.

## Status after round 3
No open findings. All 10 contracts (C1-C10) are internally consistent and cross-referenced. Plan ready to lock and proceed to Phase 2.
