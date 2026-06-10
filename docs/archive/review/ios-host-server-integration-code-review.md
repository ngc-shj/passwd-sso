# Code Review: ios-host-server-integration

Date: 2026-06-10
Review round: 1
Branch: feat/ios-custom-scheme-oauth (54 files, +1524 -456)

## Changes from Previous Round
Initial review.

## Summary
No Critical findings. Security review is substantively clean: the RLS-nesting fix
(withBypassRls no longer nested inside withUserTenantRls) is verified correct and
complete across all sites; open-redirect analysis found no vector (IOS_CALLBACK_URL
is a hardcoded server constant, redirect origin from env not request host,
resolveCallbackUrl enforces same-origin); the decryptShareData/Binary no-AAD fallback
removal is a security improvement (closed a cross-tenant decrypt path). PKCE (RFC 8252
§8.1) mitigates custom-scheme interception.

Remaining findings are 1 functional limitation (TOTP AutoFill) + C13 test-coverage
gaps (the code is device-verified working; these guard against future regression).

## Consolidated Findings (deduplicated across experts)

### Major

- **M1 (F1) — TOTP AutoFill picker is always empty.** `EntryBlobDecoder.summary` hardcodes
  `hasTOTP: false` (overview blob has no TOTP marker), and the extension filters the OTP
  picker by `hasTOTP == true` → intersection always empty. The extension advertises
  `ProvidesOneTimeCodes: true` but TOTP AutoFill never offers any entry.
  Files: `ios/Shared/Models/EntryBlobDecoder.swift:73`, `CredentialProviderViewController.swift:95`.
  Decision needed: (a) add a TOTP marker to the overview blob server-side + propagate, or
  (b) detail-decrypt at resolve time, or (c) drop `ProvidesOneTimeCodes` until implemented
  (don't advertise a broken capability).

- **M2 (F2/T1) — Real `VaultUnlocker` is never tested; tests drive a hand-rolled
  `StubVaultUnlocker` that re-implements unlock (hex/PBKDF2/AES-GCM).** A revert of the
  hex/kdfType fix in the real type would not turn any test red (RT1/RT5).
  File: `ios/PasswdSSOTests/VaultUnlockerTests.swift:58-134`. Plan item C13.1.
  Fix: extract a `VaultUnlockDataSource` protocol, inject into the real `VaultUnlocker`,
  test the real type, delete the stub.

- **M3 (T2) — `isApiCallbackUrl` untested + passkey/security-key `window.location.assign`
  branch never exercised.** Component test mocks `useCallbackUrl: () => "/dashboard"`, so the
  API-callback branch (the whole point of C4) is never hit. A regression silently breaks the
  iOS OAuth flow.
  Files: `src/lib/auth/session/callback-url.ts:84`, `passkey-signin-button.test.tsx`,
  `security-key-signin-form.test.tsx`.

- **M4 (T3) — `EntryBlobDecoder` (new shared decoder) has no dedicated unit tests** for
  server-shaped blobs: null `username`/`url`/`notes`, omitted `additionalUrlHosts`, absent
  `password` (non-LOGIN), `tags` as `{name,color}` objects, malformed JSON → nil. The
  `password ?? ""` fallback (the C10b fix) is unguarded.
  File: `ios/Shared/Models/EntryBlobDecoder.swift` (no test file).

- **M5 (T4) — `kdfType` JSON-decode is not tested at the decode level.** Tests build
  `VaultUnlockData(kdfType: 0)` in Swift directly, bypassing JSONDecoder; the actual pre-fix
  break (server int `0` vs Swift `String`) is not exercised.
  File: `ios/PasswdSSOTests/VaultUnlockerTests.swift:31`.

- **M6 (F3) — C13.3 cross-platform vault-unlock fixture absent.** No server-generated hex
  fixture fed to the iOS unlock path; hex parity is iOS-only (not cross-platform).
  (Depends on M2's protocol injection.)

### Minor

- **m1 (F8/S2) — sign-in page server redirect locale-injects API callbackUrls.** Already-
  authenticated user hitting `/[locale]/auth/signin?callbackUrl=/api/mobile/authorize`
  → next-intl `redirect({href,locale})` → `/ja/api/mobile/authorize` → 404. Unreachable in
  the iOS ephemeral-session flow; security impact none (resolveCallbackUrl validates), UX 404.
  File: `src/app/[locale]/auth/signin/page.tsx:50-51`. Fix: apply `isApiCallbackUrl` here too.
- **m2 (S1) — `/api/mobile/authorize` has no per-IP rate limiter** (cf. `/api/mobile/token` has
  10/15min). Authenticated + step-up gated; abuse = bridge-code-row write flood. Fix: add
  `checkRateLimitOrFail`.
- **m3 (S3) — bridge code issuance not audited** (cf. token route emits MOBILE_TOKEN_ISSUED).
  Fix: `logAuditAsync(MOBILE_BRIDGE_CODE_ISSUED)` on success.
- **m4 (F9) — `VaultViewModel.updateSummaryAfterEdit` drops `additionalUrlHosts`** in the
  optimistic in-memory update (defaults to []); brief AutoFill match gap until next sync.
  File: `ios/PasswdSSOApp/Views/Vault/VaultViewModel.swift:191`.
- **m5 (F6/T8) — `fetchTeamMemberships` / `fetchVaultUnlockData` Bearer scheme untested.** The
  HostSyncService:140/145 scheme fix has no regression guard.
- **m6 (F7/T7) — PSSO_DIAG CI grep guard not implemented** (C13.7). Production clean now, no
  mechanical barrier to reintroduction.
- **m7 (F4) — C13.4 canonicalHTU basePath parity test absent.** `resourceURL` basePath
  correctness unguarded.
- **m8 (F5) — C13.6 web-encrypt→iOS-decrypt AAD round-trip test absent** (only golden-vector
  AAD parity exists).
- **m9 (T5) — AuthCoordinator `callbackScheme` constant untested** (+ server IOS_CALLBACK_URL
  constant not asserted).
- **m10 (T6) — `redirectToSignIn` null-origin 500 branch untested.**
- **m11 (T9) — CredentialResolverTests passes `hasTOTP:true` fixture that the decoder ignores;
  the overwrite-to-false is unasserted.** Also: DebugVaultLoader comment references stale
  `CredentialResolver` instead of `EntryBlobDecoder`.

## Recurring Issue Check
### Functionality
R1 reported (M2), R2 clean, R3 clean (one residual → m1), R5 clean, R10 clean, R12 clean,
R17 clean (resourceURL/EntryBlobDecoder adopted), R19 clean, R20 clean (tx atomicity preserved),
R21 → C13 gaps M2/M4/M5/M6, R23 N/A, R24 clean (AAD tightening, no data), R25 clean (keychain
names intentionally not renamed; app-group renamed consistently across 5 targets), R37 note only.
### Security
R3 PASS, R5 PASS (nested $transaction removal correct), R9 PASS, R13 PASS, R14 PASS, R18 PASS,
R31 PASS (v1 permanent-delete now 403), RS1 PASS (timingSafeEqual in token routes), RS2 PARTIAL
(m2), RS3 PASS (Zod AuthorizeQuerySchema), RS4 PASS (jp.jpng = org/App-Group id, not PII; no
real emails/IPs in new docs).
### Testing
R19 partial (M3), RT1 → M2 (Critical-class, rated Major: code device-verified), RT2 (C13.3/4
testable, not untestable), RT3 minor (m9), RT4 clean, RT5 → M2.

## Resolution Status (round 1 — all findings resolved)

Verification: vitest 11099 passed; next build green; iOS full suite 228 passed.

### M1 [Major] TOTP AutoFill always empty — FIXED
- Added `hasTOTP` presence marker to the web overview blob (`personal-entry-payload.ts`);
  `EntryBlobDecoder.summary` reads it; `OverviewPlaintext` + `EntryEditForm` preserve it
  (and `additionalUrlHosts`) on iOS re-encrypt (covers m4). Tests: personal-entry-payload.test.ts,
  EntryBlobDecoderTests (hasTOTP), commit 4dca2669.
### M2 [Major] real VaultUnlocker untested — FIXED
- `VaultUnlockDataSource` protocol; `MobileAPIClient` conforms; real `VaultUnlocker` under test;
  `StubVaultUnlocker` deleted. Files: VaultUnlocker.swift, MobileAPIClient.swift, VaultUnlockerTests.swift.
### M3 [Major] isApiCallbackUrl / window.location branch untested — FIXED
- callback-url.test.ts isApiCallbackUrl cases; passkey/security-key tests exercise the
  window.location.assign API-callback branch (18 passed).
### M4 [Major] EntryBlobDecoder no unit tests — FIXED
- New EntryBlobDecoderTests.swift (9 tests: null fields, absent password, tag objects, hasTOTP, malformed).
### M5 [Major] kdfType JSON-decode untested — FIXED
- VaultUnlockerTests: integer kdfType decodes; string kdfType throws.
### M6 [Major] cross-platform vault-unlock fixture absent — FIXED
- scripts/generate-vault-unlock-fixture.mjs (Web Crypto PBKDF2-SHA256 600k → AES-GCM, matching
  crypto-client kdfType=0) → extension/test/fixtures/vault-unlock-fixture.json; VaultUnlockerTests
  `testUnlockDecodesWebGeneratedFixture` feeds it to the REAL VaultUnlocker and asserts the derived
  vault key (cross-platform hex parity). Passes.

### Minors
- m1 [Minor] sign-in page API-callback redirect — FIXED (signin/page.tsx uses next/navigation redirect
  for isApiCallbackUrl, no locale injection).
- m2 [Minor] /api/mobile/authorize no rate limiter — FIXED (per-user `authorizeLimiter` +
  checkRateLimitOrFail; test: rate-limit-blocked).
- m3 [Minor] bridge-code issuance not audited — FIXED (MOBILE_BRIDGE_CODE_ISSUED audit action: enum +
  groups + i18n en/ja + Prisma enum + migration 20260610000000 + MOBILE_BRIDGE_CODE target type +
  logAuditAsync; test asserts emit).
- m4 [Minor] additionalUrlHosts dropped on iOS edit — FIXED (see M1; also fixed the more serious
  stored-blob fidelity loss on iOS re-encrypt).
- m5 [Minor] Bearer scheme untested — FIXED (MobileAPIClientTests testFetchVaultUnlockData_usesBearerScheme).
- m6 [Minor] PSSO_DIAG CI guard absent — FIXED (scripts/checks/check-ios-no-diagnostic-logging.sh,
  `npm run check:ios-diag`, wired into pre-pr.sh; also guards DPoP-on-access-token + base64-unlock regressions).
- m7 [Minor] canonicalHTU/resourceURL basePath untested — FIXED (testResourceURL_preservesDeploymentBasePath).
- m9 [Minor] callbackScheme constant untested — FIXED (AuthCoordinatorTests testCallbackSchemeMatchesRegisteredScheme).
- m10 [Minor] redirectToSignIn null-origin 500 untested — FIXED (authorize route test).
- m8 [Minor] AAD encrypt→decrypt round-trip — COVERED by existing CredentialResolverTests
  (encrypt-with-AAD → resolve/decrypt is an integration round-trip) + AADParityTests golden vectors.
  No new test added; existing coverage exercises the path. (Anti-Deferral: not deferred — judged
  already-covered; worst case if wrong = AAD wiring regression, caught by CredentialResolverTests failing.)
- m11 [Minor] hasTOTP assertion in CredentialResolverTests — COVERED by new EntryBlobDecoderTests
  (testSummaryReadsAdditionalUrlHostsAndTOTPMarker directly asserts hasTOTP from the overview blob),
  which is the canonical decode path. CredentialResolverTests fixture comment left as-is.

Termination: all Critical/Major fixed; all Minor fixed or covered. Round 1 closes.

## Round 2 (incremental re-review of the round-1 fix diff f10da95a..HEAD)

Security expert: **no new findings** — rate limiter placement/keying, audit action +
migration, sign-in redirect (no open-redirect), and the hasTOTP marker are all verified
safe; the round-1 RLS-nesting fix is intact. Functionality: all round-1 fixes verified
correct & complete; M6 fixture algorithm confirmed to match crypto-client kdfType=0. No
Critical/Major. New Minor findings:

- **F1 [Minor] FIXED** — `VaultUnlocker.unlock` did not guard `kdfType != 0`; an Argon2id
  vault would surface as a misleading "invalid passphrase". Added a `kdfType == 0` guard
  (→ serverResponseInvalid) + test `testUnlockRejectsUnsupportedKdfType`.
- **F2 [Minor, security-relevant] FIXED** — iOS re-encrypt dropped the web-only overview
  fields `requireReprompt` (master-passphrase re-prompt) and `travelSafe`, silently
  downgrading them on the next web load. Now decoded in `EntryBlobDecoder` →
  `VaultEntrySummary` and preserved through `EntryEditForm`/`OverviewPlaintext` on
  re-encrypt (same preserve-on-edit pattern as additionalUrlHosts/hasTOTP). Tests added.
- **T4 [Minor] FIXED** — authorize test's `extractRequestMeta` mock was missing
  `acceptLanguage` (shape drift); added `acceptLanguage: null`.
- **T1 [Minor] REJECTED** — the fixture multi-fallback URL lookup matches the established
  codebase pattern (URLMatchingTests/TOTPVectorTests use `fixtures/<name>` as the primary
  form successfully); defensive, test passes. No change.
- **T2 [Minor] REJECTED** — claim that the fixture `encryptedSecretKey` is 31 bytes is a
  miscount; verified 64 hex chars = 32 bytes (correct AES-GCM ciphertext). M6 test is valid.
- **T3 [Minor] REJECTED (with clarifying comment)** — broadening the DPoP guard to `DPoP \(`
  would false-positive on the legitimate `Authorization: DPoP \(refreshToken)` refresh path.
  The narrow `\(accessToken)` pattern is intentional; added a comment to the guard script.

Verification: full iOS suite 231 passed; authorize route test 15 passed; check:ios-diag green.

Termination: Round 2 yielded only Minor findings, all fixed or rejected-with-justification.
Note: F2 touched a security-relevant flag (requireReprompt) — but as a strict-safety
preservation (it STOPS iOS from dropping the flag), not a new boundary. Round 2 closes.

## Round 3 (re-review of the round-2 fix diff 956989dd..HEAD)

Security: F2 downgrade closure VERIFIED (all VaultEntrySummary→EntryEditForm paths go through
blob decode; no residual drop path). Also found requireReprompt is ALSO a DB column and the
web enforces via the DB column (iOS never sends it in the PUT body), so the actual auth-control
was never at risk from iOS edits — F2 is fidelity-correctness, defence-in-depth. F1 fails closed,
no leak. No new security findings.

- **F3 [Minor] FIXED** — the round-2 F2 fix itself had a bug: `travelSafe: summary.travelSafe ? true : nil`
  collapsed an explicit `false` (travel-unsafe) to absent, which the web reads as travel-safe —
  flipping a travel-unsafe entry back to safe on the next web load. Fixed by making
  `VaultEntrySummary.travelSafe` three-state (`Bool?`) and passing it through verbatim
  (nil→omit, true/false preserved). Tests updated + explicit-false guard added.
- **T5 [Minor] FIXED** — F2's encode (write-back) path was untested; added
  `EntryEncrypterTests.testEncryptPersonalEntry_preservesRequireRepromptAndTravelSafe`
  (encrypt→decrypt→summary round-trip) to guard against CodingKeys/rename drift.
- **F4 [Major] NEW — ESCALATED (pre-existing, surfaced by T5)** — iOS encodes entry `tags` as
  `[String]` (both `OverviewPlaintext` and `EntryPlaintext`), but `EntryBlobDecoder`
  (and the web) expect `[{name,color}]` objects. All existing tests use empty tags, so this was
  never caught. Consequence: editing a TAGGED entry on iOS rewrites the blobs with string tags →
  the next `EntryBlobDecoder.summary`/`detail` decode FAILS → the entry disappears from the iOS
  list and its detail won't decrypt. Not introduced by these fixes (OverviewPlaintext/EntryPlaintext
  always used [String]); it is in files this PR touched, so it is in scope. Proposed fix: encode
  iOS tags as `[{name, color: nil}]` objects (names preserved; colors are already dropped at decode,
  so iOS edits cannot preserve colors without a deeper change). Awaiting user decision on scope.

Verification: full iOS suite 233 passed (F3 + T5). Round 3 fixed F3/T5; F4 (Major) escalated.
