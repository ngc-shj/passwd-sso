# Plan Review: ios-host-server-integration
Date: 2026-06-10
Review round: 1

## Changes from Previous Round
Initial review (3 parallel experts: functionality, security, testing) of the consolidated iOS↔server integration plan. Primary goal: proactively find the remaining client↔server contract mismatches on the post-unlock paths (C10) before device testing.

## Functionality Findings
- **F1 Critical** — `ios/PasswdSSOApp/Vault/HostSyncService.swift:140` still sends `Authorization: DPoP` (C9 missed site). → resolution: fix to `Bearer` (C9 completion). Team sync also needs the server bearer-bypass list extended (see C12 / deferred).
- **F2 Critical** — `URL(string:relativeTo:)` drops basePath. `fetchEntries` (`MobileAPIClient.swift:321`/`EntryFetcher.swift:136`) and `fetchTeamEntries` (`:279`) build URLs with `URL(string: "/api/...", relativeTo: serverURL)`, which resolves to `https://host/api/...` (basePath `/passwd-sso` dropped) → 404 + DPoP htu mismatch (`canonicalHTU` also wrong). Breaks personal entry list on basePath deployments (current gx10). → C10a.
- **F3 Critical** — `VaultEntrySummary`/`VaultEntryDetail` require fields absent from server blobs: `id`, `urlHost`, `additionalUrlHosts` are not in the blob (id lives in `CacheEntry.id`); decode fails → all entries silently dropped. → C10b.
- **F4 Major** — TOTP: server blob has `totp: {secret, algorithm?, digits?, period?}`; iOS expects flat `totpSecret: String?` → always nil. → C10c.
- **F5 Major** — `additionalUrlHosts: [String]` non-optional but server omits when empty → decode fails for most entries. → C10b.
- **F6 Major** — `url`/`notes`/`username` non-optional `String` but server sends `null` → decode fails for common entries. → C10b.
- **F7 Minor** — `EncryptedEntry.encryptedBlob` non-optional; only safe because `fetchPersonal` always sends `?include=blob`. → note in C10a.

## Security Findings
- **S1 Critical (escalate)** = F1 (same root cause). DPoP-scheme team call 401s; I1 invariant incomplete. Fix = C9 completion.
- **S2–S5 — Confirmed secure (no finding)**: DPoP sender-constraint IS fully enforced when `Authorization: Bearer` is used (validateExtensionToken → validateExtensionTokenDpop checks `ath`=SHA-256(token) + `cnf.jkt`); C3 reclassification preserves session+IP enforcement in the handler, GET-exempt CSRF, fixed-constant scheme redirect (no open-redirect); C6 env-origin no host injection; C7 RLS no cross-tenant write.
- **S6 Medium** — PSSO_DIAG NSLog lines (10 sites). No token/passphrase/key VALUE is logged (lengths + error descriptions + kdf metadata only). One line logs ≤300B of non-200 response body — could surface server error bodies in device/crash logs. Remove all (C11).

## Testing Findings
- **T1 High (RT1)** — `StubVaultUnlocker` re-implements `VaultUnlocker.unlock`; the real class is never tested → C8 bug was invisible. Fix: inject a `VaultUnlockAPIClient` protocol, test the real actor. → C13.
- **T2/T3 High (RT3)** — `MobileAPIClientTests.swift:329`, `VaultViewModelTests.swift:114`, `EntryFetcherTests.swift:112`, and the postCacheRollbackReport test assert `DPoP ` for resource calls that now send `Bearer ` → will fail on next `xcodebuild test`. Update to `Bearer ` (keep `DPoP ` for refresh). `fetchTeamMemberships` scheme untested. → C13.
- **T4 High (RT2)** — no server-generated (hex) fixture feeds the iOS unlock decode; both sides use the same Swift hexEncode. Add `extension/test/fixtures/vault-unlock-fixture.json`. → C13.
- **T5 Medium** — no `canonicalHTU` basePath test (iOS + server parity). → C13.
- **T6 Medium** — `EntryFetcherTests` fixtures use 16-byte IVs (32 hex) — real GCM IV is 12 bytes (24 hex). Fix fixtures. → C13.
- **T7 Medium** — AAD: `AADParityTests` checks golden vectors but no web-encrypt→iOS-decrypt round-trip; no test that the unlock `userId` flows into entry AAD. → C13.
- **T11 Medium** — `refreshToken()` (keeps DPoP) has zero tests; risk of homogenization regression. → C13.
- **T9/T10 Low** — no CI grep guard for PSSO_DIAG; no proxy test that mobile/authorize does not bearer-bypass. → C13 (best-effort).

## Adjacent Findings
- S7 [Adjacent] = F1 functional dimension (routed to functionality, already F1).
- F2 [Adjacent→security]: htu mismatch is also a DPoP-binding concern (covered by S2 reasoning; the fix is functional).

## Resolution decisions
- **C9** completed to include `HostSyncService.swift:140` (F1/S1).
- **C10a/b/c** (F2–F6) added as locked contracts — personal-vault entry path.
- **Team vault (fetchTeamEntries/fetchTeamMemberships) DEFERRED**: `EXTENSION_TOKEN_ROUTES` does not include `TEAMS`; the extension/CLI do not read team passwords via Bearer either. Team read requires extending the server bearer-bypass surface + scope — a separate, security-sensitive feature. This pass targets PERSONAL vault end-to-end. Tracked: `TODO(ios-host-server-integration): team vault read over Bearer/DPoP — extend EXTENSION_TOKEN_ROUTES + scope`.
- **C11** remove all PSSO_DIAG (S6).
- **C13** testing contracts (T1–T11) — implemented alongside the code fixes per the 30-minute / anti-deferral rule.

## Recurring Issue Check
### Functionality expert
- Shared-utility duplication: iOS `canonicalHTU` vs server `canonicalHtu` diverge on basePath (F2). Enum/constant consumer gap: `EXTENSION_TOKEN_ROUTES` vs `SESSION_REQUIRED_PREFIXES` (team gap). No async-in-tx / circular import in scope.
### Security expert
- No control weakened by design; S1 is an incomplete fix (now C9-completed). DPoP/CSRF/IP/RLS/open-redirect all verified intact.
### Testing expert
- RT1 (stub reimplements code), RT2 (no client↔server fixture parity), RT3 (stale scheme asserts), RT4 (no keep-DPoP refresh test) — all routed to C13.
