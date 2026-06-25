# Plan Review: ios-demo-mode
Date: 2026-06-25
Review rounds: 2 (all findings resolved)

---

# Round 2 (incremental)

## Changes from Previous Round
Core architecture pivot: demo no longer reuses the live `VaultListView` (which wires `apiClient`/`hostSyncService`/`autoLockService`/favicon/Settings unconditionally). Demo now renders a **dedicated `DemoVaultView`** over an in-memory cache, making NFR1/NFR2 a structural property enforced by a grep gate rather than per-site guards. C1 test now drives the real decrypt path; C2 isolation is a grep gate (not a vacuous spy); C3 uses a pure predicate (no snapshot harness).

## Round-1 dispositions (all verified against source)
F1→Resolved (dedicated view; `categoryGrid`/`entryList` confirmed private, reimplemented; `EntrySummaryRow`/`CategoryCard` reusable). F2→Resolved (entryType strings match `EntryTypeCategory` raw values + decoder literals exactly, incl. `SECURE_NOTE`). F3/F4→Resolved structurally + verified the favicon gate is dead at `EntryIconView.decision` when `showFavicons:false`, and `FaviconLoader.shared` stays nil without `configure`. F5→Resolved. S1/S2/S3/S6→Resolved structurally (verified residual-singleton vector does not survive; no `URLCache.shared`; no `DebugVaultLoader.reset()` on exit). S4/S5→Resolved. T1-T7→Resolved (grep gate replaces unreliable real-container/keychain assertions; real decrypt path; golden-payload lockstep; TOTP unit assertion).

## Round-2 new findings (resolved in plan)
- **[F7/S7/T8] High — the recurring root**: `EntryDetailView` AND `VaultCategoryListView` declare non-optional `apiClient: MobileAPIClient`/`hostSyncService`/`autoLockService` (EntryDetailView.swift:15-18, VaultCategoryLanding.swift:75-78); `MobileAPIClient.init` drags in the forbidden `HostTokenStore`. Reusing either verbatim contradicts the grep gate. The C3 "reuse note" treated the read-only seam as optional and omitted `VaultCategoryListView`; the grep scope was a hardcoded two-file list that wouldn't cover the extracted seam (RT6). **Fixed**: C3 now makes the read-only seam **mandatory** for both views (extract `isReadOnly`/trimmed views taking none of the three collaborators; per-type section renderers extracted from `EntryDetailTypeSections.swift`), and the grep gate is now a glob (`Demo*.swift` + `*ReadOnly*.swift`).
- **[F8/S8] Low**: extracted copy helpers reference `autoLockService` + read `AppSettingsStore().clipboardClearSeconds`. **Fixed**: C3 drops the autoLock activity calls in the seam and documents the clipboard read as an accepted read-only access (fail-closed default; not a write → no contamination).
- **[T9] Low**: C1 cited non-existent `decryptPersonalOverviews`. **Fixed**: replaced with `loadFromCache`/`loadDetail` (real public path); noted `decryptOverview` is the private worker.
- **[T10] Low**: C1 asserted internal `allSummaries`. **Fixed**: assert public `filteredSummaries.count == 9`.
- **[RT7 gap] Low**: C3 predicate test lacked a prove-red step. **Fixed**: C3 acceptance now requires flipping a flag default → test goes red, and requires the view to consume the same constants the test asserts.

## Round-2 escalation
No Critical findings. F7/S7 is High but a plan-completeness gap (the grep gate would fail the build rather than ship contamination) — `escalate: false`. All four contracts now `locked`.

---

# Round 1

## Changes from Previous Round
Initial review.

## Functionality Findings

- **[F1] Critical**: `.demo` cannot construct `VaultListView` without `autoLockService`/`apiClient`/`hostSyncService`/`keyVersion` — all non-optional (`VaultListView.swift:15-24`). The terminal-state "carries nothing" design (C2) contradicts the view signature. Fix: thread `mode` AND make those deps optional + gate every use, OR build a dedicated `DemoVaultView` reusing the rendering subviews. Enumerate ~10 references at VaultListView.swift:69,75,98,101,108,143,156-157,233,308,344,379,386.
- **[F2] Critical**: Demo `CacheEntry` omits `entryType` → all 8 types collapse to "Login" (`EntryTypeCategory.from(rawType:nil)=.login`; decoder builds type sub-struct only when entryType matches, EntryBlobDecoder.swift:303-336; the DebugVaultLoader template never sets it). Defeats FR2. Fix: C1 sets `entryType` per fixture; assert per-type classification.
- **[F3] Major**: Favicon auto-fetch on browse path = network call in demo (NFR2). VaultListView.swift:150-160 → FaviconLoader.configure; image(forHost:) → apiClient.fetchFavicon. Fix: force `showFavicons=false` in demo, skip configure; add to C3.
- **[F4] Major**: `.refreshable` + `scenePhase==.active` still wired to `sync()` (VaultListView.swift:120-125,323,356). Fix: gate both behind `mode==.live`.
- **[F5] Minor**: C1 says `teamDirectory: nil` but signature is `[TeamDirectoryEntry] = []`. Fix: reword to `[]`.
- **[F6] Minor**: count arithmetic OK (8 types, login×2 = 9 entries); C1 test must enumerate each of 9 by type (folds into F2).

## Security Findings

- **[S1] Critical (escalate:true)**: Favicon path writes the **shared** App Group cache (`FaviconLoader.swift:117-129` → `<AppGroup>/vault/favicon-cache/`) AND makes network calls; omitted from NFR1 + every forbidden-pattern list. Falls back to `loadServerConfig()?.baseURL`. Fix: force `showFavicons=false` (don't read shared store), gate `FaviconLoader.configure` behind `mode==.live`, add `FaviconLoader`/`faviconCacheDirectory` to C1+C3 forbidden + NFR1 surface; test favicon dir absent + `fetchFavicon` never called.
- **[S2] Critical (escalate:true)**: `VaultListView` needs live `apiClient`/`hostSyncService` and unconditionally runs `sync()` (shared-cache write + network) on scenePhase/refresh (VaultListView.swift:120-125,323,356,375-402 → `hostSyncService.runSync`). Direct path to the central contamination threat. Fix: make deps optional/mode-gated; `sync()` first stmt `guard mode==.live else return`; gate scenePhase + both `.refreshable`; add `hostSyncService`/`runSync` to C3 forbidden; extend C2 spy to `runSync`.
- **[S3] Major**: Demo menu exposes Settings (writes shared app-group UserDefaults), Lock, Sign Out (VaultListView.swift:70-99). Plan known-risk note ("no settings UI reachable") contradicts the code. Fix: C3 hides Settings/Lock/Sign Out in demo; resolve `autoLockService` absence.
- **[S4] Major**: Residue-on-exit not provably empty — favicon disk cache + QuickType identity clears are wired to `AutoLockService`/sign-out, which don't run on demo exit. Fix: if favicons disabled (S1), collapses to "verify no favicon dir"; add post-exit asserts (favicon dir + `ASCredentialIdentityStore` count unchanged); document the app-switcher snapshot of (fake) demo data as accepted.
- **[S5] Major**: NFR3 fakeness asserted but fixtures not in plan; mirrored DebugVaultLoader carries the published test TOTP seed `JBSWY3DPEHPK3PXP` (acceptable, but call it out) + `example.com` (RFC 2606, OK). Fix: NFR3 sub-assertion (all usernames RFC 2606 reserved domains; secrets fake/published-test); grep test for non-`example.*` domains; confirm `docs/assets/passwd-sso.json` is NOT in the app bundle Copy Resources phase.
- **[S6] Minor**: Inverse contamination (demo reads real vault) NOT possible via `loadFromCache` (reads in-memory param, VaultViewModel.swift:98-101); only vector is `sync()` (covered by S2). `loadTeamKeys` runs only when `cacheKey!=nil`; demo passes nil → no shared wrapped-key read. Good.

## Testing Findings

- **[T1] Critical**: C1 isolation assertion `fileExists(cacheFileURL())==false` unreliable — the shared container is polluted by prior runs/DebugVaultLoader; can't distinguish demo's write. Zero existing tests touch the real `AppGroupContainer`; all inject a temp dir (DebugVaultLoaderTests.swift:23). Fix: drop absolute non-existence; rely on the Forbidden-patterns grep (the real, falsifiable gate) + optional before/after mtime-unchanged.
- **[T2] Major**: "no Keychain item written" has no injection seam (C1 sig takes no params → hits real polluted keychain). Idiom injects `MockKeychainAccessor`. Fix: rely on the Forbidden grep for `BridgeKeyStore`/`HostTokenStore`/`saveVaultKey`; don't author a real-keychain query.
- **[T3] Major**: C1 names the wrong API — `EntryBlobDecoder.summary/.detail` take **plaintext**, not encrypted blobs (EntryBlobDecoder.swift:212,276); decrypt is `decryptOverview`/`decryptEntryDetail`. Bare-decoder test bypasses the encrypt+AAD wiring (wrong AAD/key/userId uncaught). Fix: C1 test drives the real path — `vm.loadFromCache` then assert `allSummaries.count==9` + per-type via `loadDetail`, OR `decryptPersonalOverviews(from:vaultKey:userId:)`. (RT1)
- **[T4] Major**: C3 "snapshot/structural test" untestable — no snapshot lib, empty UITest target, no SwiftUI body inspection in the codebase. Fix: extract a pure predicate (`VaultMode.showsMutationAffordances`/`.showsSyncControls`/`.signOutLabel`) and unit-test the enum. (RT2/RT7)
- **[T5] Major**: C2/C3 negative invariants ("runSync/registrar never called") have no spy seam — `.demo` constructs none of them (RootView.swift:101,119,393 inline). "Spy + assert zero" is vacuous. Fix: make the invariant compile-time/structural (Forbidden grep — already lists `onVaultReady`/`refreshCredentialIdentities`/`CredentialIdentityRegistrar`); prove-red by injecting the call. Drop the "injected spy" wording, OR inject the registrar into `VaultListView` (a `FakeIdentityStore` spy already exists). (RT7)
- **[T6] Minor**: C1 fixtures duplicate the existing `EntryBlobGoldenPayloadTests.swift` (per-type golden payloads, all 8 types, with a "add new type in lockstep" comment). Fix: `DemoVaultFactory` builds from / asserts against the same shapes; C1 test asserts only factory-specific concerns. (R1/RT3)
- **[T7] Minor**: TOTP-copy (FR2) only in the manual plan but unit-testable. Fix: C1 sub-assertion — decrypt the demo login detail, assert `totpSecret == known`.

## Adjacent Findings
- F1 [Adjacent → security]: ephemeral-key zeroization relies on ARC; security pass noted (S4 covers residue).
- S3/S1 [Adjacent → functionality]: the mode gate must propagate to `EntryDetailView`/`VaultCategoryListView`/`EntrySummaryRow`, not only `VaultListView` (R3).

## Quality Warnings
None — all findings carry file:line evidence and concrete fixes.

## Recurring Issue Check
### Functionality expert
R3=F1/F5; R7=F2/F5; R8=F1; R25=N/A (demo persists nothing, by design); R39=ephemeral key freed by ARC, no Keychain/disk → OK; R41=F2/F3/F4. R1,R2,R4-R6,R9-R24,R26-R38,R40 = N/A or Checked-no-issue.

### Security expert
R3=S1/S3 (propagate gate to EntryDetailView/VaultCategoryListView/EntrySummaryRow); R31=DebugVaultLoader.reset() deletes real shared state — demo exit must NOT call it (plan OK, exit is appState=.setup only); R34=favicon/sync pre-existing but in-scope; R39=S4; R40=fixture vs decoder shape OK by design; RS4=plan PII clean (Alice Example/example.com), confirm passwd-sso.json not bundled. RS1-RS3,RS5 = N/A. Others Checked/N/A.

### Testing expert
RT1=T3/T6; RT2=T1/T2/T4; RT5=T3/T5 (adjacent); RT6=DemoVaultFactory/DemoVault/VaultMode new exports — tests in same PR; RT7=T1/T4/T5 (each needs an explicit prove-red step). R1=T6. RT3=T6. RT4 = N/A (no race tests).

## Security escalation
S1 and S2 flagged `escalate: true` (NFR1/NFR2 — the plan's paramount invariants — failing on surfaces the plan never enumerated, touching shared App-Group disk + network). Orchestrator assessment: the Sonnet security findings are concrete, evidenced, and already actionable; the root cause (reuse of `VaultListView` wires favicon/sync/settings to shared state) is the SAME root as F1/S2/S3 and is fully understood. Re-running on Opus would not change the fix. **Escalation declined** — proceeding to plan revision with the findings as-is.
