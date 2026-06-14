# Code Review: ios-passkey-registration

Date: 2026-06-13
Review round: 1 (Phase 3) — incremental verification on top of the Phase 2 self-R-check baseline.

## Changes from Previous Round

Initial Phase-3 review. Three Sonnet experts (functionality / security / testing) reviewed
`git diff main...HEAD` with the no-lockout single-completion-point as the hardest target.
No Critical, 2 Major (both test-coverage gaps for the server S-C1/S-C2 acceptance criteria),
5 Minor. All resolved this round.

## Functionality Findings

- **F1 [Minor] — `appendEntryToCache` TOCTOU window**: a concurrent host sync between
  `readDirect()` and `readCacheFile` makes the counter check fail with `cacheUnavailable`.
  Already correct as best-effort (server copy is durable; local cache self-heals on next
  host sync). Resolution: documented (the manual test's happy-path note + extension README
  orphan/best-effort section already cover the "authenticate immediately after register"
  scenario). No code change.
- **F2 [Minor] — redundant `UploadTokenStore()` in the `onNonceUpdate` closure**: the
  closure created a second instance instead of capturing the one already on the stack.
  Functionally identical (same Keychain coordinates) but a future-divergence/readability
  risk. **Fixed**: capture `[uploadTokenStore]`.

All 9 Ollama functionality seeds **rejected** (flags-0x45 claim false [code is 0x5D];
missing-access-group deliberate per deviation log; stale-call-site/compile claims false
[build green]; nonce-not-persisted false [S5 staged]; lock-doesn't-clear-nonce false
[clear() removes all three items]; nil-refresher false; save-failure-unhandled false
[refresh() never throws]; nil-URL-crash false [optional binding]; stale-comment false).
Implementation Checklist: all 15 files present in the diff.

## Security Findings

- **S1 [Minor] — mint endpoint accepted any extension-token clientKind**: the route gated on
  `auth.type === "token"`, which is true for `BROWSER_EXTENSION` / `IOS_AUTOFILL` tokens too,
  not just the intended `IOS_APP` host token. Exploitable only with SE-key device compromise;
  impact is registration DoS (revokes the victim's live AutoFill token), no privilege
  escalation. **Fixed**: threaded `clientKind` onto `ValidatedExtensionToken` →
  `AuthResult["token"]` and added `auth.clientKind !== "IOS_APP" → 401` to the route, with
  two new negative tests (BROWSER_EXTENSION / IOS_AUTOFILL → 401). `escalate: false`.
- **S2 [Minor] — no DB CHECK constraint for `IOS_AUTOFILL` cnf_jkt**: `BROWSER_EXTENSION`
  has a partial `CHECK (... OR cnf_jkt IS NOT NULL)`; `IOS_AUTOFILL` had only the runtime
  guard. **Fixed**: new migration `20260613000001_ios_autofill_cnf_jkt_required` adds the
  analogous partial CHECK.

Security seeds: AfterFirstUnlock "any process" premise **rejected** (iOS access groups are
entitlement-bound to the two app targets); EntryUploader-logs-token **rejected** (zero log
statements in the file); SE-key-no-biometric-ACL **verified-but-no-action** (biometric ACL
would break the extension's no-UI provide context; same posture as the shipped host DPoP key).
Thumbprint canonicalization Swift↔TS byte-identical; private-key JWK lifecycle confirmed no
persisted copy beyond the ceremony.

## Testing Findings

- **T1 [Major] — no Vitest naming the `IOS_AUTOFILL` validation path**: the S-C1 invariant
  (IOS_AUTOFILL is DPoP-required, not bypassed) was only structurally covered by the
  BROWSER_EXTENSION tests. **Fixed**: two tests in `extension-token.test.ts` (valid DPoP →
  ok with clientKind IOS_AUTOFILL; absent/invalid DPoP → invalid, no bypass).
- **T2 [Major] — `issueAutofillToken` untested (route mocks it away)**: the single-active
  revocation, fresh familyId, cnfJkt persistence, scope, and 5-min TTL had no unit test.
  **Fixed**: `describe("issueAutofillToken")` block in `mobile-token.test.ts` (3 tests).
- **T3 [Minor] — C1 golden vectors were structural + decoder, not byte-equality**: the plan
  asked for byte vectors AND a CBOR decoder. **Fixed**: added two exact-byte golden-vector
  tests (`testCOSEKeyExactGoldenBytes`, `testNoneAttestationObjectExactGoldenBytes`) pinning
  the wire framing/length-encoding; residual (no cross-impl TS-captured fixture exists —
  the extension fixtures dir has none) recorded in the deviation log, mitigated by the
  end-to-end server-accepts-blob + assertion-decoder-reads-back parity.
- **T4 [Minor] — 429 rate-limit test ordering risk**: uses a distinct `u-rl` userId so the
  per-user bucket starts fresh under Vitest module isolation; latent risk only if a future
  test reuses the id. Resolution: distinct userId already isolates it; noted here for future
  test authors. Non-vacuous (removing the limiter fails the test). No code change.

Testing seeds: unavailable (truncated) → full-diff review performed.

## Recurring Issue Check

### Functionality expert
R1-R37 clean. Notable: R1 (SSoT — shared helpers/CreateEntryRequest moved to one site),
R17 (no-lockout single completion point), R30 (attestation flags 0x5D, zero AAGUID, none fmt).

### Security expert
R1-R37 + RS1-RS4 clean. R19/R20 (no TLS pinning delegate in EntryUploader) flagged
[Adjacent] as a pre-existing posture shared with MobileAPIClient (not introduced here).
RS2 (rate limit) FIXED in Phase 2; RS3 (scope minimisation passwords:write only) clean;
RS4 (no secrets in logs) clean.

### Testing expert
R1-R37 + RT1-RT5 clean post-fix. T1/T2 closed the S-C1/S-C2 acceptance coverage; the VC
registration flow remains intentionally untested at the VC level (sealed context) with the
pure `passkeyRegistrationOutcome` carrying the invariant — confirmed no VC-only branching.

## Resolution Status

### F2 [Minor] redundant UploadTokenStore instance — Fixed
- Action: capture `[uploadTokenStore]` in the `onNonceUpdate` closure.
- Modified file: ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift:380

### S1 [Minor] mint endpoint missing clientKind gate — Fixed
- Action: added `clientKind` to ValidatedExtensionToken / AuthResult["token"]; gate route on IOS_APP; 2 negative tests.
- Modified files: src/lib/auth/tokens/extension-token-types.ts, src/lib/auth/dpop/validate-token-dpop.ts, src/lib/auth/tokens/mobile-token.ts, src/lib/auth/session/auth-or-token.ts, src/app/api/mobile/autofill-token/route.ts (+ route.test.ts)

### S2 [Minor] missing IOS_AUTOFILL cnf_jkt CHECK — Fixed
- Action: new migration with partial CHECK constraint.
- Modified file: prisma/migrations/20260613000001_ios_autofill_cnf_jkt_required/migration.sql

### T1 [Major] IOS_AUTOFILL validation path untested — Fixed
- Action: 2 tests in extension-token.test.ts (DPoP-required, no bypass).
- Modified file: src/lib/auth/tokens/extension-token.test.ts

### T2 [Major] issueAutofillToken untested — Fixed
- Action: describe block (single-active revoke, fresh familyId, scope/TTL/cnfJkt).
- Modified file: src/lib/auth/tokens/mobile-token.test.ts

### T3 [Minor] golden-vector byte-equality — Fixed
- Action: 2 exact-byte tests; residual (no TS-captured fixture) logged as deviation.
- Modified files: ios/PasswdSSOTests/PasskeyRegistrationTests.swift, deviation log

### F1 [Minor] appendEntryToCache TOCTOU — Accepted (documented)
- Anti-Deferral check: acceptable risk, quantified.
- Worst case: the just-registered passkey is absent from the local QuickType set until the next host foreground sync (server copy is durable; assertion still works after sync).
- Likelihood: low (narrow window between two Keychain reads, only under a concurrent host sync).
- Cost to fix: a retry/lock mechanism in the cache-append path — disproportionate to a self-healing best-effort step the plan explicitly scoped as best-effort.
- Orchestrator sign-off: documented in manual-test + README; no code change.

### T4 [Minor] 429 test ordering risk — Accepted (already isolated)
- Anti-Deferral check: acceptable risk, quantified.
- Worst case: a FUTURE test reusing userId "u-rl" could perturb the bucket count.
- Likelihood: low; the test is non-vacuous today (distinct userId + module isolation).
- Cost to fix: a limiter-key reset hook — not warranted now.
- Orchestrator sign-off: noted for future test authors.

## Round 1 verification
Server: vitest (auth/mobile/extension trees) 938 pass; next build clean.
iOS: PasskeyRegistrationTests + CredentialResolverTests pass after fixes (full suite re-run before final commit).

---

# Round 2 (incremental) — post-implementation work (sync UI + flag cleanup)

Date: 2026-06-14
Scope: `git diff 6db8852e...HEAD` — flag revert (0x45→0x5D), completeRegistration/
completeAssertion `expired`-misread log removal, host-app vault sync feature
(pull-to-refresh + "Sync now" + foreground auto-refresh), Localizable.xcstrings.
Three experts (functionality / security / testing). No Critical, no Major-with-impact.

## Findings & resolution

- **F1 / T8 [Minor] — plan doc stale**: line 51 still said "CORRECTED → 0x45" after
  the 0x5D revert. **Fixed**: rewritten to state 0x5D is correct (Apple provider
  requirement; Safari-confirmed) with the 0x45 misstep noted as history.
- **S1 [Minor] — `sync()` lacked a locked-state guard**: a background idle-lock
  could race a queued foreground refresh, decrypting summaries into a
  deallocating view state (not persisted/transmitted; not exploitable).
  **Fixed**: `guard autoLockService.state == .unlocked else { return }` at the top
  of `sync()`.
- **F2 / S2 [Minor] — double foreground `runSync`**: the app shell and the vault
  list both call `runSync` on `.active`; the actor serialized them but each did a
  full network sync + bridge-counter increment. **Fixed**: single-flight in
  `HostSyncService` — concurrent callers coalesce onto one in-flight sync (one
  round-trip, one counter bump), benefiting every caller (app shell, vault list,
  background task).
- **T5 [Major→accepted] — `sync()` has no unit test**: the logic lives in a
  SwiftUI View method; the repo has no view-logic unit-test harness and the real
  `HostSyncService.runSync`/single-flight network path is not directly unit-tested
  (the suite uses `StubHostSyncService`). Anti-Deferral: acceptable risk —
  worst case a silently-broken single-flight guard re-introduces the (harmless)
  double sync; likelihood low; cost-to-fix = extracting a `@Observable` sync
  model + building MobileAPIClient/EntryFetcher mocks, disproportionate.
  Tracked as a follow-up (extract `SyncState` if view sync logic grows).
- **T9 [Minor]** — `StubHostSyncService.runSync()` signature differs from
  production: intentional private test stub, not a defect. No action.

## Recurring Issue Check
Functionality R1-R37, Security R1-R37 + RS1-RS4, Testing R1-R37 + RT1-RT5 — all
clean on the changed lines except the Minors above (resolved). 0x5D flag and log
removals verified correct (Apple-mandated; no secrets logged). New xcstrings keys
all have `state: translated` ja, satisfying LocalizationCatalogTests.

## Round 2 verification
iOS 462 XCTest green; build green. (Server unchanged this round.)
