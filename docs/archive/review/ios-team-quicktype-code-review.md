# Code Review: ios-team-quicktype

Date: 2026-06-15
Review round: 1 (Phase 3, implementation review)

## Changes from Previous Round

Initial Phase-3 implementation review of the iOS team-key AutoFill + QuickType + in-app team vault
feature (contracts C1-C10 + implementation deviations D1-D3), reviewed against the uncommitted working tree
(base = ios-main). Three expert sub-agents (functionality, security, testing). **No security escalation**
(`escalate: false`): the proxy Bearer-bypass boundary change (D1) was independently verified safe. 3
Critical/Major behavioral findings + several Minor defense-in-depth / test-quality findings — all resolved
in this round (no deferrals).

## Functionality Findings

- **F1 (Critical → resolved)** `HostSyncService.performSync` wiped all team keys on a transient
  `/api/teams` (membership-list) fetch failure.
  - File: `ios/PasswdSSOApp/Vault/HostSyncService.swift`
  - Problem: a non-auth failure of `fetchTeamMemberships()` set `teams = []`; with the ECDH key present,
    `refreshTeamKeys` did a "full rewrite" `saveTeamKeys([])`, wiping still-valid team keys (and the team
    directory). Indistinguishable from "user is on zero teams". Violated the C7 resilience intent.
  - Impact: any transient network/5xx on `/api/teams` during sync → team fill + in-app team display outage
    until the next successful sync (self-healing, but a full team-feature blackout in between).
  - Fix: track `teamsAuthoritative`; `refreshTeamKeys` returns early (touching nothing) when the list was a
    transient-failure fallback. The authoritative empty list (genuinely 0 teams) still full-rewrites so
    revocation correctly drops teams.
- **F2 (Major → resolved)** team-directory blob not wiped on sign-out (same root cause as **S13**).
  - File: `ios/PasswdSSOApp/Vault/AutoLockService.swift`
  - Problem: `signOut()` called `wrappedKeyStore.clearAll()` (vault/team/ECDH blobs) but never cleared the
    `TeamDirectoryStore` (`vault/team-directory.json`), which lives outside `WrappedKeyStore`. Contradicts
    plan C10b ("cleared in clearAll()/sign-out").
  - Impact: encrypted team-name residue survives sign-out (metadata: prior account was on ≥1 team). R25/R39
    sign-out-wipe gap.
  - Fix: inject `teamDirectoryStore: any TeamDirectoryStoring = TeamDirectoryStore()` into `AutoLockService`;
    `signOut()` now calls `teamDirectoryStore.clear()`.
- **F3 (Major → resolved)** `CredentialResolver.decryptEntryDetail` (fill path) had no team-key staleness
  check.
  - File: `ios/Shared/AutoFill/CredentialResolver.swift`
  - Problem: `resolveCandidates` (the QuickType list) enforces the 15-min `teamKeyMaxAge` bound, but the
    fill path `decryptEntryDetail` did not — a stale team key (post-revocation, sync not yet run) would
    still FILL the credential beyond the revocation window.
  - Impact: breaks the "revoked membership stops filling within ≤15 min" guarantee on the fill path.
  - Fix: `decryptEntryDetail` now throws `Error.entryNotFound` when `now() - wrapped.issuedAt > teamKeyMaxAge`,
    matching `resolveCandidates`.
- **F4 (Minor → resolved)** `EntryDetailView.loadDetail()` did not pass `cacheKey` explicitly, relying on the
  VM's `loadedCacheKey` fallback (nil before `loadFromCache` → silent team-detail decrypt failure at a
  cold-launch edge).
  - Fix: pass `cacheKey: cacheKey` to `viewModel.loadDetail`.
- **F5 (Minor → resolved)** malformed/undecryptable persisted ECDH key left stale team keys uncleaned (the
  all-stale cleanup only ran on the no-ECDH branch).
  - Fix: extracted `clearTeamKeysIfAllStale(now:)`; both the no-ECDH and malformed-ECDH branches now run it.

## Security Findings

- **Proxy Bearer-bypass boundary (D1) — VERIFIED SAFE, no finding, escalate: false.** Every `/api/teams/*`
  route enforces its own authorization: scope-gated routes use `checkAuth(..., { scope: PASSWORDS_READ })` +
  team-membership checks (list, per-team passwords, member-key — the three the iOS token uses); session-only
  sub-routes (`members`, `rotate-key`, `invitations`, `webhooks`, `policy`, `tags`, `folders`, `audit-logs`)
  use `auth()` and reject cookieless Bearer with 401 from the handler. No team route delegates authz to the
  proxy session gate. `startsWith(route + "/")` child matching exposes no un-authz'd sub-route. CORS preflight
  allows chrome-extension origins on Bearer routes without credentialed CORS; baseline CSRF still fires on
  cookie-bearing mutating requests. Covered by cors-gate.test.ts + api-route.test.ts.
- **AAD binding symmetry — VERIFIED correct, no finding.** `buildLocalWrapAAD` ("LW") is a single impl called
  by both host write and on-device read via `TeamEntryDecryptor`; `userId` on both sides is
  `cacheData.header.userId` (F16). Team-key wrap AAD "OK" (4-field) byte-identical to the extension (golden
  vector). kty/crv P-256 validated (S6). Plan findings S1/S2/S6 confirmed implemented.
- **S13 (Major → resolved)** = F2 (team-directory not wiped on sign-out). Resolved in `AutoLockService`.
- **S15 (Minor → resolved)** missing defensive `assert(wrapped.teamId == teamId)` (plan S12).
  - Fix: added the assert in `TeamEntryDecryptor.teamEntryKey` after the lookup (defense for a future
    lookup/unwrap decoupling; AEAD `wrapped.teamId` binding remains the actual enforcement).
- **S16 (Minor → resolved)** ECDH shared-secret bytes (`sharedBytes`) not zeroized in
  `TeamKeyCrypto.unwrapTeamKey`. Fix: `var` + `defer resetBytes` (R39, matches PKCS#8 pattern).
- **S17 (Minor → resolved)** team-enc-key bytes (`keyBytes`) not zeroized in `TeamEntryDecryptor.wrapTeamKey`.
  Fix: `var` + `defer resetBytes`.
- **S18 (Minor → resolved)** item-key plaintext (`itemKeyData`) not zeroized in
  `TeamEntryDecryptor.resolveTeamEntryKey`. Fix: `guard var` + `defer resetBytes`.
- **S14 (Major → accepted with justification, see Resolution Status)** plaintext key material
  (`secretKeyHex`, `pkcs8PrivKeyHex`, `rawTeamKeyHex`, item keys) in the committed golden-vector fixture
  `team-key-fixture.json`. These are synthetic, randomly-generated test vectors and are REQUIRED inputs/
  expected-values to anchor the cross-platform crypto chain (standard for crypto golden vectors, cf. NIST
  CAVP / RFC test vectors) — removing them would make the golden vectors impossible. Not production secrets.

## Testing Findings

- **T1 (Critical→see resolution)** golden-vector test (a) `testUnwrapEcdhPrivateKey_importsAndRoundTrips`
  loaded `f.pkcs8PrivKeyHex` but asserted only an iOS-vs-iOS self round-trip. Resolution: strengthen to assert
  `derRepresentation == f.pkcs8PrivKeyHex` if byte-identical; otherwise revert to self-check WITH an explicit
  comment that cross-platform import correctness is anchored transitively by tests (b)/(c)/(d) (rawTeamKey,
  teamEncKey, overview all match the extension — the ECDH key MUST have imported correctly to produce them).
  Severity downgraded from Critical: the import IS anchored downstream, so this is a clarity/anchoring
  improvement, not an un-tested-correctness gap.
- **T4 (Minor → resolved)** no negative test for tampered ECDH-private-key ciphertext (S5 gap). Fix: add
  `testUnwrapEcdhPrivateKey_tamperedCiphertext_throws`.
- **T7 (Minor → resolved)** `fetchTeamMemberKey` 200 test did not assert `ephemeralPublicKey` decode. Fix: add
  the assertion.
- **T8 (Minor → resolved)** team-key sync test did not assert `storedKey.teamKeyVersion` threading. Fix: add
  the assertion.
- **T2/T3/T5/T6 — no action.** T2 (itemKeyVersion1 anchored to fixture itemEncKeyHex — correct), T3
  (sync `throws`, `XCTAssertThrowsError` correct — N/A), T5 (resilience assertions correct), T6 (AAD
  hand-computed string value correct; readability-only).
- **Regression tests for F1/F2/F3** added alongside the fixes (a fix without a failing-before test is
  incomplete): HostSyncService transient-list-failure → set unchanged; CredentialResolver stale fill →
  entryNotFound; AutoLockService signOut → team directory cleared.

## Adjacent Findings
- Functionality expert noted the session-only `/api/teams` sub-routes are unreachable by the iOS Bearer token
  (correct — iOS only needs list + member-key + passwords, all `checkAuth`-gated) → routed to Security,
  confirmed safe (no finding).

## Quality Warnings
None.

## Recurring Issue Check (consolidated)

### Functionality
- R1 (shared helper reuse) PASS — TeamEntryDecryptor is the single team-decrypt path; no duplication in
  CredentialResolver. R3 (cacheKey propagation) PASS after F4 (all call sites pass the real
  UnlockResult.cacheKey; none derive from readDirect()). R25 (persist/hydrate) PASS after F2 (ECDH + team
  keys + team directory all save/load/clear-on-signout). R38 (fail-open) addressed: F1 prevents
  transient-failure wipe; signOut clears all. R40 (cross-boundary serialization) PASS — TeamMemberKeyResponse
  decodes the server's actual JSON shape (ephemeralPublicKey is a String on both sides). R41 (declared
  capability backing) PASS — QuickType registration wired at all sync sites with cacheKey. R2/R12/R19 N/A or
  PASS.

### Security
- RS3 (input validation) PASS (JSONDecoder fails closed; server validates keyVersion; kty/crv validated).
  RS4 — fixture key material accepted-with-justification (S14); no secrets in logs. RS5 (untrusted crypto
  params) PASS for kty/crv; hkdfSalt length not floored (advisory, HKDF-safe). R18 (allowlist sync) PASS (D1
  + tests). R39 (zeroization) PASS after S16/S17/S18. RS1 (HKDF infos are domain separators, not secrets)
  N/A. R3 PASS (cacheKey threading via UnlockResult.cacheKey; no readDirect() derivation).

### Testing
- RT1 (mock-reality) PASS (member-key stub matches TeamMemberKeyResponse). RT2 PASS. RT5 (production
  call-path) PASS. RT6 (new exports tested) PASS. RT7 (provably-red guards) PASS after T1/T4. R19 (mock
  alignment — all WrappedKeyStore conformers updated) PASS. R25 (round-trip crosses real fs boundary) PASS.

## Environment Verification Report
- R35 Tier-2 manual-test artifact: `docs/archive/review/ios-team-quicktype-manual-test.md` present
  (Pre-conditions / Scenarios 1-4 / Adversarial: revocation-15min, sign-out wipe, clock-skew, cross-tenant /
  Rollback). Device-only paths are `blocked-deferred` to manual execution by design (AutoFill + biometric +
  cross-process key lifecycle cannot be unit-tested) — predicted by the plan's R35 Tier-2 classification.
- Automated gates: iOS 506 tests (504 unit + 2 UI) — re-run after this round's fixes/regression tests (see
  Resolution Status); server `npx vitest run` (11322 pass; 1 load-induced flake, passes in isolation);
  `npx next build` green (after the tsconfig exclude for the new fixture script).

## Resolution Status

### F1 Critical — team-key wipe on transient membership-list failure — Fixed
- Action: added `teamsAuthoritative` flag in `performSync`; `refreshTeamKeys` returns early when not
  authoritative (no save / no directory write). Regression test added (transient `/api/teams` failure →
  existing set unchanged).
- Modified: ios/PasswdSSOApp/Vault/HostSyncService.swift

### F2 / S13 Major — team directory not wiped on sign-out — Fixed
- Action: injected `TeamDirectoryStoring` into AutoLockService; `signOut()` calls `clear()`. Regression test
  added (signOut → directory cleared).
- Modified: ios/PasswdSSOApp/Vault/AutoLockService.swift

### F3 Major — fill-path missing staleness check — Fixed
- Action: `decryptEntryDetail` enforces `teamKeyMaxAge`. Regression test added (stale key → entryNotFound).
- Modified: ios/Shared/AutoFill/CredentialResolver.swift

### F4 Minor — EntryDetailView cacheKey not threaded — Fixed
- Modified: ios/PasswdSSOApp/Views/Vault/EntryDetailView.swift

### F5 Minor — malformed ECDH leaves stale keys — Fixed
- Action: `clearTeamKeysIfAllStale(now:)` run in both no-ECDH and malformed-ECDH branches.
- Modified: ios/PasswdSSOApp/Vault/HostSyncService.swift

### S15 Minor — defensive teamId assert — Fixed
- Modified: ios/Shared/AutoFill/TeamEntryDecryptor.swift

### S16/S17/S18 Minor — key-material zeroization — Fixed
- Modified: ios/Shared/Crypto/TeamKeyCrypto.swift, ios/Shared/AutoFill/TeamEntryDecryptor.swift

### S14 Major — plaintext keys in committed fixture — Accepted
- **Anti-Deferral check**: acceptable risk (quantified).
- **Justification**:
  - Worst case: a secret scanner emits a false-positive on a 32-byte hex string in a test fixture.
  - Likelihood: low — these are randomly-generated synthetic test vectors (not provider-format tokens that
    GitHub/trufflehog secret scanners match); the file is a test fixture, not config.
  - Cost to fix "properly" (remove the keys): would destroy the golden vectors — the secretKey/PKCS#8/rawTeamKey
    are the REQUIRED inputs+expected-values that anchor cross-platform crypto parity (standard practice, cf.
    NIST CAVP / RFC test vectors). Removing them yields no cross-platform anchor (the whole point of C9).
- **Orchestrator sign-off**: accepted — committing synthetic crypto test vectors is correct and intended; the
  risk is bounded false-positive scanner noise, not a real secret exposure.

### T1 — golden-vector self-check → strengthened-or-documented (regression subagent)
- Action: attempt `derRepresentation == f.pkcs8PrivKeyHex`; keep if it passes, else revert with an explicit
  anchoring comment. Outcome recorded by the regression subagent.
- Modified: ios/PasswdSSOTests/TeamKeyCryptoTests.swift

### T4/T7/T8 Minor — added negative + assertion coverage — Fixed
- Modified: ios/PasswdSSOTests/{TeamKeyCryptoTests,MobileAPIClientTests,HostSyncServiceTests}.swift

### Final verification — DONE (all gates green)
- **iOS**: `xcodegen generate` + `build-for-testing` (`** TEST BUILD SUCCEEDED **`) +
  `test-without-building` → **511 unit + 2 UI tests, 0 failures** (`** TEST EXECUTE SUCCEEDED **`), verified
  independently in the orchestrator context (R21). +7 tests over the pre-round 504 (regression F1/F2/F3 +
  T1/T4/T7/T8). T1 outcome: the stronger cross-platform anchor was KEPT — CryptoKit `derRepresentation` is
  byte-identical to WebCrypto pkcs8 for the fixture key.
- **Server**: `npx vitest run` 11322 pass (1 load-induced flake, passes in isolation); `npx next build`
  green (after the tsconfig exclude for scripts/generate-team-key-fixture.ts). No server code changed after
  these runs (iOS-only fixes this round).

## Resolution

All Critical/Major findings resolved; review converged in round 1. No commit made (per repository convention —
commit only on explicit request).
