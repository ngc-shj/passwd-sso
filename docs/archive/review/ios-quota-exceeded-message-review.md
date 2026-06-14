# Plan Review: ios-quota-exceeded-message

Date: 2026-06-14
Review round: 1

## Changes from Previous Round

Initial review (3 expert agents: functionality / security / testing) of the S10-A quota-exceeded plan.

## Functionality Findings

- **F1 (Critical) — wrong type name**: plan used `EntryEditForm`; the Swift type is `EntryForm`
  (file `EntryEditForm.swift:12`). → RESOLVED: plan now references type `EntryForm` (file path unchanged).
- **F2 (Major) — shared chokepoint "harmless" claim unsubstantiated**: `decodeBodyResponse` also serves
  `mintAutofillToken`. → RESOLVED: C2 documents the shared chokepoint, body-code-keyed forward-compat design,
  and that the only UI-surfaced consumer is create; others propagate/swallow (no regression).
- **F3 (positive) — no exhaustive `switch` over `MobileAPIError`** anywhere → adding a case is safe. Recorded in
  C1; re-grep at impl time (R19).
- **F4 (positive) — JSONDecoder ignores extra body fields** (`resource/current/max`) → `{error:String}` decode is
  safe. Recorded in C2.
- **F5 (Major) — access control**: helper must be `internal`, not `private`; hosted test target reaches internal
  symbols. → RESOLVED: C3 specifies `nonisolated static` + internal, "must NOT be private".
- **F6 (Major) — incomplete walkthrough**: 401-nonce-retry path (line 743) also routes through
  `decodeBodyResponse`. → RESOLVED: C2 walkthrough now covers both retry and non-retry paths.
- **F7 (Minor) — VM test infra**: `MobileAPIClient` is a concrete actor (no protocol mock); stub via HTTP layer.
  → RESOLVED (folded into T3): C5 VM test uses `MockURLProtocol`.
- **F8 (Minor) — shared catch for create+edit**: `.quotaExceeded` unreachable on edit. → RESOLVED: C3 notes the
  dead-branch coverage is harmless.

## Security Findings

- **S1 (Minor) — info leak**: `MobileAPIError.localizedDescription` exposes case labels/associated values (e.g.
  DPoP nonce) in debug/TestFlight UI via the `else` branch. → RESOLVED: C3 `else` branch now returns a controlled
  generic localized message (C4 generic key), no `localizedDescription` interpolation. Full `LocalizedError`
  conformance deferred as a tracked TODO (richer messages, +8 strings — out of this PR's small scope).
- **S2 (Minor) — chokepoint placement** → same as F2; body-code-keyed detection accepted (no masking of genuine
  403s; exact `==` compare). RESOLVED via C2 documentation.
- **S3 (none) — untrusted body decode**: bounded, single-string, `try?`-guarded, never rendered/logged/shelled.
  Safe.
- **S4 (none) — error oracle**: no new info channel; server already discriminates on the wire.
- **S5 / RS4 (none)** — test fixtures use synthetic numbers only; no PII/secrets.
- escalate: false (no Critical security findings).

## Testing Findings

- **T1 (Critical) — RT1 mock-reality**: existing non-2xx tests stub `Data()`; quota tests MUST stub real JSON
  bodies or they fail/pass vacuously. → RESOLVED: C5 specifies `Data(#"{...}"#.utf8)` bodies.
- **T2 (Critical) — testability**: `String(localized:)` bundle resolution + `@MainActor` dispatch. → RESOLVED:
  C3 helper is `nonisolated static` (no MainActor wrap); C5 test computes the expected string via the same
  `String(localized:)` call (identical resolution, not a hardcoded literal) → non-vacuous, locale-robust.
- **T3 (Major) — VM test infra**: no protocol mock; use `MockURLProtocol`. → RESOLVED in C5.
- **T4 (Major) — LocalizationCatalogTests checks `state:"translated"`**: → RESOLVED: C4 mandates
  `state:"translated"` on `ja` units + exact JSON shape.
- **T5 (Major) — missing negative tests**: empty/malformed body. → RESOLVED: C5 adds
  `testCreateEntry_403WithEmptyBodyMapsToServerError` + `...MalformedBody...`.
- **T6 (Minor) — VM handler must return 403 immediately** (no preceding 201). → RESOLVED: noted in C5.
- **T7 (Minor) — @MainActor dispatch** → RESOLVED by `nonisolated static` (C3).

## Adjacent Findings

None requiring cross-routing beyond those already merged above.

## Quality Warnings

None (all findings carried file:line evidence and concrete fixes).

## Recurring Issue Check

### Functionality expert
- R3: in scope — error propagation verified (VM rethrows, UI catches), no swallowing. R19: in scope — no
  exhaustive switch over MobileAPIError (verified). R25: N/A (transient error, not persisted). R37: in scope —
  C4 strings jargon-free. R1-R2, R4-R18, R20-R36: N/A (client-only Swift change).

### Security expert
- R37: partial→resolved (S1 else-branch hardened). RS4: clear (synthetic fixtures). R19/R25: clear (no
  exhaustive switch; no persisted state). RS1-RS3, all other R*: N/A (no auth/crypto/SQL/shell/new endpoint).

### Testing expert
- RT1: was failing→resolved (real JSON bodies). RT2: was partial→resolved (nonisolated static + same-resolution
  expected). RT3: resolved (HTTP-layer mock). RT4: N/A (no concurrency/cardinality test). RT5: N/A. R37: covered
  by C4 + reviewer grep. Other R*: N/A.

## Resolution Status

All round-1 findings (F1-F8, S1-S5, T1-T7) are RESOLVED in the plan or recorded as positive/no-action. One
tracked deferral:

### S1-followup (Minor) `MobileAPIError: LocalizedError` full conformance — Out of scope (different feature)
- **Anti-Deferral check**: out of scope (different feature / larger change).
- **Justification**: the info-leak itself IS fixed in this PR (C3 controlled generic else-branch). What is
  deferred is the *enhancement* of richer per-case localized messages, which needs ~8 new localized strings and
  a `LocalizedError` extension — beyond S10-A's "small" scope as scoped by the user. Tracked via grep-able
  `TODO(ios-quota-exceeded-message)` marker in the plan's Considerations section.
- **Orchestrator sign-off**: the security-relevant leak is closed in-PR; only a non-security UX enhancement is
  deferred with a TODO marker. Exception satisfied.

---

# Review round 2 (incremental)

## Changes from Previous Round

Verified all round-1 resolutions in the updated plan. Functionality + Testing each raised one new Minor;
Security: No findings (S1 confirmed fully resolved by the C3 controlled else-branch).

## Functionality Findings (round 2)
- **F9 (Minor, new) — stale type name in Go/No-Go table**: gate row C3 still read `EntryEditForm`. → RESOLVED:
  gate row now `EntryForm.saveErrorMessage(for:)`.
- Confirmed clean: removing `"Save failed: %@"` is safe (only refs: catalog + the call site being replaced;
  AutoFill ext catalog unaffected). `nonisolated static` on `@MainActor struct` is valid Swift 6
  (project `SWIFT_STRICT_CONCURRENCY: complete`; matches `VaultUnlocker.swift:247` pattern).

## Security Findings (round 2)
- No findings. S1 leak closed by construction (static localized string, no `localizedDescription` interpolation);
  C4 strings jargon-free (R37); deferral is UX-only. escalate: false.

## Testing Findings (round 2)
- **T8 (Minor, new) — access-token seeding**: `createEntry` calls `validAccessToken()` first → throws
  `.authenticationRequired` before the mock unless a token is seeded. → RESOLVED: C5 now requires
  `seedAccessToken()` at the start of each MobileAPIClientTests quota test. (VaultViewModelTests already seeds in
  `setUp()`.)
- Confirmed clean: `httpResponse(status:url:)` helper (`MobileAPIClientTests.swift:53`) and
  `MockURLProtocol.requestHandler` `(Data, HTTPURLResponse)` shapes match C5; `LocalizationCatalogTests` reads
  source `.xcstrings` and enforces ja `state=="translated"` (line 130-136); XcodeGen auto-discovers
  `PasswdSSOTests/*.swift`; hosted-test `Bundle.main` resolves to the host app so `String(localized:)` finds the
  new keys.

## Recurring Issue Check (round 2)
- All experts: round-1 items verified resolved; F9/T8 resolved; no Critical/Major remaining. R19/R37/RT1/RT2/RS4
  all clean.

## Resolution Status (round 2)
All round-2 findings (F9, T8) RESOLVED in the plan. No open findings. **Plan converged** — proceeding to Phase 2.
All contracts C1-C5 `locked`.
