# Plan Review: ios-i18n

Date: 2026-06-12
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (functionality, security, testing) reviewed
`ios-i18n-plan.md` against the actual iOS codebase. Security returned no findings
(static-string i18n, no auth/crypto/data-flow change — matches the plan's own
near-empty-security assessment). Functionality raised 1 Critical + 2 Major + 4 Minor.
Testing raised 3 Major + 3 Minor, all centered on the coverage test's load mechanism
and the do-not-translate carve-out.

## Functionality Findings

### F1 — Critical: `knownRegions: [en, ja]` under `options:` is a no-op; `ja` is auto-derived from catalog content
- Evidence: empirically tested xcodegen (CI installs via `brew install xcodegen`, ci.yml:306). `options.knownRegions` is silently ignored; regenerated pbxproj emitted `Base, en`. The real mechanism: xcodegen derives regions by scanning `.xcstrings` content — a catalog containing an authored `ja` localization → pbxproj `Base, en, ja`; an en-only catalog → reverts to `Base, en`. Current `project.pbxproj:766` = `knownRegions = (Base, en)`.
- Impact: following C1 literally adds dead config; implementer sees `Base, en` and concludes wiring failed, or ships without `ja` if a catalog lacks an authored `ja` unit at generate time. The plan's "top risk" is mis-diagnosed.
- Fix: drop the `options.knownRegions` instruction; document that `ja` is auto-derived from the catalog's authored `ja` localizations → C5 (ja authoring) is a hard prerequisite for C1 acceptance; run C1's region check AFTER ja units exist.

### F2 — Major: C2 misses plain-`String` sites that won't auto-localize
- Evidence: `EntryEditForm.swift:124,143-148` — `var navigationTitle: String` (`"New Entry"`/`"Edit Entry"`) consumed at `.navigationTitle(navigationTitle)`; a `String` *variable* binds the `StringProtocol` overload → NOT localized. `EntryDetailView.swift:107,109,153-154` — `fieldRow(label: String)` → `Section(label)` with `"Username"`/`"URL"` → `StringProtocol` overload → NOT localized. The plan lists these under the *auto-localized* bucket, which is wrong, and `"New Entry"`/`"Edit Entry"` are absent from the inventory.
- Impact: these ship in English even after the catalog lands; C6 won't catch it (strings never enter the catalog).
- Fix: convert `navigationTitle` to `LocalizedStringKey` (or `String(localized:)` the literals); change `fieldRow(label:)` to `LocalizedStringKey`; add the four strings to the host catalog + ja.

### F3 — Major: Inventory omits ~12 concrete host strings (SettingsView + EntryDetailView)
- Evidence: SettingsView.swift:69,74,76,79,81-84,87,88,95,96 (`"Auto-Lock"`, `"On Timeout"`, `"Log Out"`, `"Security"`, idle-time footer, `"Clipboard"`, `"Auto-Clear"`, `"Appearance"`, `"Theme"`); EntryDetailView.swift:46,121,132,139 (`"Couldn't decrypt this entry."`, `"One-Time Code"`, `"Tags"`, the "kept when you save an edit here" footnote — distinct from EntryEditForm.swift:111's similar footnote).
- Impact: these auto-localize but C5 needs a hand-authored ja for each; if the inventory is the authoring checklist, they get English/placeholder ja → C6 fails late, or two near-duplicate footnotes get conflated.
- Fix: replace "etc." with an authoritative key list derived by building once and inspecting the generated catalog (Xcode auto-extraction); call out the two distinct footnotes as separate keys.

### F4 — Minor: interpolated error literals localize at the assignment/`errorDescription` site, not at `Text(message)`
- Evidence: ServerURLSetupView.swift:35,115,150 — `Text(message)` with a `String` variable is the non-localizing overload (correct: renders already-localized runtime text); the literal conversion must happen at line 35 / `ProbeError.errorDescription`. SignInView.swift:54,99,112 is the same shape; the `"DEBUG: …"` at :112 is correctly excluded.
- Fix: note in C2/C4 that the literal is localized at its assignment/`errorDescription` site and `Text(message)` stays as-is.

### F5 — Minor: pin the markdown-bold interpolation key with positional specifiers
- Evidence: CredentialPickerView.swift:118 `Text("Fill **\(summary.username)** for app:\n\(bundleID)")` extracts to `"Fill **%@** for app:\n%@"`; ja word order needs `%1$@`/`%2$@` and must keep `**…**`.
- Fix: author this key explicitly: en `"Fill **%1$@** for app:\n%2$@"`, ja preserving `**%1$@**` and `\n%2$@`; manual test asserts bold + correct substitution.

### F6 — Minor: ja plural variation uses only the `other` category
- Evidence: SettingsView.swift:71,90 — `Int` interpolation extracts to `%lld`; Japanese has no count distinction.
- Fix: C4/C6 state ja plural supplies only `other`; the coverage test must treat a ja plural unit with `other` (no `one`) as complete. (Merge with T4.)

### F7 — Minor: biometrics label is two separate keys
- Evidence: RootView.swift:160-165,172 builds `biometryLabel` (`"Face ID"`/`"Touch ID"` literal, `"biometrics"` → `String(localized:)`); VaultUnlockView.swift:63 `Label("Unlock with \(biometryLabel)", …)` extracts to template `"Unlock with %@"`.
- Fix: list both keys — `"biometrics"` (standalone) and `"Unlock with %@"` (template) — and document `%@` receives an unlocalized product name OR the localized "biometrics" (don't fold Face ID into the template).

## Security Findings

No findings. Investigated all five named risks:
1. `Save failed: %@` / `Could not reach %@` / CredentialPicker interpolations — args are `error.localizedDescription` (system passthrough), user-typed URL (query/fragment stripped at ServerURLSetupView.swift:69,90), and username/bundleID (already shown). No password/key/passphrase in scope. VaultUnlockView errors are fully static and correctly do NOT interpolate `error.localizedDescription`.
2. RootView biometric/unlock control flow (RootView.swift:155-187, VaultUnlockView.swift:126-146) is untouched — pure string substitution; `localizedReason` localization is Apple-recommended and doesn't affect `canEvaluatePolicy`.
3. BridgeKeyStore precondition trap (BridgeKeyStore.swift:100-101) NOT reachable — C6 test does pure JSON parsing, instantiates no production type.
4. RS4: plan has no PII; only generic `https://`/`localhost` examples. Pre-emptive guard: the not-yet-written manual-test doc must use placeholder URLs/emails.
5. R37: ja copy is end-user vocabulary; no implementation jargon in unlock/locked-fallback flows.

## Testing Findings

### T1 — Major: coverage-test resource-loading mechanism unspecified; raw `.xcstrings` in a resources phase gets compiled, not copied verbatim
- Evidence: plan:54-55 leaves load mechanism as an unresolved either/or. Catalogs live in app/extension dirs, not the test target (`PasswdSSOTests`, project.yml:180-211). A `.xcstrings` added to a resources build phase is compiled into `.lproj`/`.strings` → `url(forResource:"Localizable", withExtension:"xcstrings")` returns nil.
- Fix: lock the mechanism (see resolution — read source via `#filePath`-relative path).

### T2 — Major: `#filePath`-relative loading caveats
- Evidence: `#filePath` resolves to the compile-machine source path; works on the iOS Simulator (shares host FS) but breaks on a physical device / sandboxed runner; deviates from the `Bundle(for:)` idiom used by URLMatchingTests.swift:29 etc.
- Fix: acceptable for this CI (simulator); document the device-runner caveat. Chosen deliberately because it validates the committed source-of-truth catalog and sidesteps T1's compilation pitfall.

### T3 — Major: coverage test has no carve-out for do-not-translate keys that land in the catalog
- Evidence: plan keeps brand/product names out of the catalog (plan:17,35-36,41) but C6 asserts EVERY entry has a translated ja (plan:54). Auto-extraction may pull `Face ID`/`passwd-sso` into a key → test demands ja for an intentionally-literal key → false failure, or a dev "fixes" it by translating a brand.
- Fix: mark such keys `"shouldTranslate": false` in the catalog; the coverage test SKIPS entries where `shouldTranslate == false`.

### T4 — Minor: plural assertion under-specified
- Fix: for plural keys require en has `one`+`other`, ja has at least `other`, each non-empty + translated. (Merged with F6.)

### T5 — Minor: "~301 existing tests" is actually 299; do not instantiate BridgeKeyStore in the new test
- Evidence: 299 `func test*` methods; BridgeKeyStore() default init only at RootView.swift (host), not test-bundle load → #540 trap N/A for this test.
- Fix: say "all existing tests + the new coverage test"; keep the localization test free of keychain I/O.

### T6 — Minor: top risk (knownRegions/`ja` survives xcodegen) has manual-only verification
- Evidence: JSON-content test validates source, not the built bundle; a regression dropping `ja` from the build ships green.
- Fix: add a runtime host-bundle assertion `Bundle.main.localizations.contains("ja")` to convert the top risk to a CI-guarded check; keep the manual ja-render check as a required release gate; create `ios-i18n-plan-manual-test.md`.

## Adjacent Findings

- F6 tagged [Adjacent] → testing (plural assertion shape); merged into T4.

## Recurring Issue Check

### Functionality expert
- R3 (propagation across both bundles): PARTIAL — shared strings (`"Cancel"`, `"Recording — content hidden"`) correctly duplicated per-catalog, but F2/F3 missed strings leave propagation incomplete as written.
- R12 (every key needs ja): AT RISK via F2/F3 — missed strings never become catalog keys, so C6 passes while they render English.
- R37 (jargon leak): LOW — watch consistent "Vault" wording and web-aligned terms for footnotes.
- R1/R2/R4–R11/R13–R36: N/A (i18n; no DB/event/migration/transaction/runtime-artifact change).

### Security expert
- RS1/RS2/RS3: N/A (no comparison/endpoint/input surface added).
- RS4: Pass for plan + ja strings; pre-emptive guard for the manual-test doc (placeholder URLs/emails).
- R37: Pass.
- DB/transaction/runtime (R9/R13/R14): N/A.

### Testing expert
- RT1: N/A (no mocks).
- RT2: FAIL as written → T1/T2/T3; JSON parse + ja-presence + plural checks ARE testable once load mechanism + skip-list are locked.
- RT3: Partial → T3/T4/T6.
- RT4/RT5: N/A (single-threaded JSON parse; BridgeKeyStore trap confirmed not triggered).
- R12: enforced in intent for both catalogs + plurals, but incomplete until T1/T3/T6 resolved.
