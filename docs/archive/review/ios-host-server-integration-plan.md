# iOS Host App ↔ Self-Hosted Server Integration — Plan

Branch: `feat/ios-custom-scheme-oauth`
Date: 2026-06-10

## Project context

- **Type**: mixed (Next.js web app + Swift iOS host app + browser extension + CLI, one monorepo / git worktree)
- **Test infrastructure**: unit + integration (`vitest` for web 11k tests; XCTest for iOS 212 unit + 1 UI; `test:integration` real-DB) + `next build` typecheck. No device CI for iOS.
- **Scope of this plan**: the iOS host app's runtime contract with the **real** server (not the simulator DEBUG fixture). The iOS AutoFill MVP was merged with sections A/B/C/D explicitly **deferred and never exercised end-to-end** (see `ios-autofill-mvp-verification-status.md`). Resuming that verification surfaced a chain of iOS↔server contract mismatches, each found one-at-a-time on device. This plan consolidates the fixes already made and **proactively enumerates the remaining client↔server contracts** so the rest are reconciled in one pass instead of by repeated device testing.

## Objective

Make the iOS host app complete the real end-to-end flow against a self-hosted server: **OAuth sign-in → token (DPoP-bound) → vault unlock → entry list decrypt → entry detail (password/TOTP) → manual edit**, with no remaining client↔server contract mismatch, and with automated tests that would have caught each mismatch.

## Requirements

### Functional
- Sign-in works against ANY self-hosted server host (no per-host config baked into the app).
- After sign-in, the iOS access token authenticates every protected resource call.
- Vault unlock decrypts web-encrypted key material with the correct passphrase.
- Entry list/detail decrypt web-encrypted blobs (personal + team).
- Manual edit (personal entry) round-trips to the server.

### Non-functional
- No regression to web/extension/CLI auth (shared proxy + `authOrToken` + `validateExtensionToken`).
- Tenant network-boundary (IP access restriction) preserved on the iOS token path.
- No diagnostic logging of secrets; remove temporary `PSSO_DIAG` logs before merge.
- Mandatory checks green: `vitest run`, `next build`, iOS `xcodebuild test`.

## Technical approach

The root cause class is **"the iOS client was built to a spec that diverges from what the shared server/web actually implements,"** uncaught because the iOS↔real-server path had no automated coverage. The server side is the source of truth (shared by web/extension/CLI); the iOS client is reconciled to it. Where the server itself had a latent bug only reachable via the iOS path (RLS nesting), the server is fixed.

## Contracts

Completed contracts are marked with their commit. Remaining contracts (C9+) are the active work; the plan review must verify the completed ones did not introduce regressions AND hunt the codebase for additional unreconciled contracts.

### C1 — Custom-scheme OAuth callback (committed 846952e7) — locked
- iOS opens `/api/mobile/authorize`; server 302s the ASWebAuthenticationSession to `passwd-sso://auth/callback?code&state`; `ASWebAuthenticationSession(callbackURLScheme: "passwd-sso")` captures it.
- Replaces Universal Link (`.https`) which required the server host baked into `associated-domains` — impossible for arbitrary self-hosted hosts.
- Server `authorize` route: unauthenticated → 302 to sign-in page (callbackUrl=self); authenticated → 302 to the fixed `passwd-sso://` scheme (server constant → not open-redirect, F15 preserved).
- Removed dead Universal Link plumbing (`associated-domains` entitlement, `handleUniversalLink`, `onOpenURL` forwarding, `WebAuthParams.host/callbackPath`).

### C2 — Bundle ID + App Group + keychain group rename (committed 846952e7) — locked
- `com.passwd-sso(.*)` → `jp.jpng.passwd-sso(.*)` for all 5 targets + App Group `group.jp.jpng.passwd-sso.shared` + keychain access group. Keychain **service** names (data keys, e.g. `com.passwd-sso.host-tokens`) intentionally NOT renamed (renaming only orphans data).

### C3 — Proxy classification of /api/mobile/authorize (committed ff6c0b27) — locked
- Removed `MOBILE_AUTHORIZE` from `SESSION_REQUIRED_EXACT_PATHS` → `api-default`, so the unauthenticated ephemeral-browser request reaches the handler (was 401'd by the proxy session gate before the handler could redirect).
- The route handler self-enforces tenant IP access restriction via `enforceAccessRestriction(req, userId)`, matching `/api/mobile/token`, to preserve the control the proxy gate used to provide.

### C4 — WebAuthn callbackUrl not locale-prefixed for API routes (committed edfaf931) — locked
- `isApiCallbackUrl()` helper; passkey + security-key sign-in use `window.location.assign(callbackUrl)` for API callbacks (next-intl router would inject `/<locale>` → 404). SSO/email unaffected (Auth.js own redirect).

### C5 — basePath-qualified callbackUrl (committed ed44d930) → superseded by C6 — locked
### C6 — env-origin (not request host) for sign-in redirect (committed cf417d7b) — locked
- `redirectToSignIn` derives origin+basePath from `getAppOrigin()`/`resolveBasePath()` (env), takes only the PATH from `req.nextUrl` (basePath stripped by Next → re-added), builds callbackUrl `${basePath}${pathname}${search}`. Fixes both `/<locale>/` injection and the reverse-proxy internal-host leak (`localhost:3001`).

### C7 — RLS nesting in authorize (committed 8a6fbce1) — locked
- `withBypassRls` must not nest inside `withUserTenantRls` (guard `INVALID_RLS_NESTING`). Resolve tenant in the RLS scope first, then bypass-insert at top level (mirrors extension bridge-code route). Latent bug, only reachable once C3 made the route execute.

### C8 — Vault unlock field decoding (committed 5e57bd8a) — locked
- `VaultUnlockData.kdfType: String` → `Int` (server Prisma sends JSON number; String decode failed the whole struct).
- `accountSalt/encryptedSecretKey/secretKeyIv/secretKeyAuthTag` decoded with `hexDecode` not `Data(base64Encoded:)` — server stores hex (web `crypto-client` `hexEncode`; schema VarChar lengths confirm). Test `StubVaultUnlocker` updated to mirror the hex path.
- **Open**: only validated for PBKDF2 (kdfType=0). Argon2id (kdfType=1) vaults cannot be unlocked by iOS (no Argon2 impl). MVP assumes PBKDF2 default; Argon2 is a documented gap, not in scope here.

### C9 — iOS Authorization scheme for access-token requests (in-flight, uncommitted) — pending
- **Problem**: iOS sends `Authorization: DPoP <accessToken>` for resource calls. The proxy bearer-bypass keys on `^Bearer ` and `authOrToken`/`validateExtensionToken` extract the token via `/^Bearer\s+/`. Result: DPoP-scheme requests are not bypassed (VAULT is in `SESSION_REQUIRED_PREFIXES`) → 401 before the handler, and even if they reached it the token would not be extracted. The DPoP **proof** is a separate `DPoP` header (already sent); only the Authorization **scheme** is wrong.
- **Contract**: every iOS request carrying the **access** token uses `Authorization: Bearer <accessToken>` + `DPoP: <proof>` header. The **refresh** request keeps `Authorization: DPoP <refreshToken>` because `/api/mobile/token/refresh` extracts via `/^DPoP\s+/` (`extractDpopBearer`).
- **Sites** (iOS): `MobileAPIClient.swift` resource calls (fetchVaultUnlockData, fetchTeamEntries, fetchEntries, postCacheRollbackReport, updateEntry) + `HostSyncService.swift:140`. NOT `refreshToken` (line 195).
- **Acceptance**: `/api/vault/unlock/data` returns 200 to the iOS token; proxy bearer-bypass triggers; `validateExtensionToken` IOS_APP DPoP path validates (`ath`=SHA-256(accessToken), `cnf.jkt`=row cnfJkt).

### C9 (cont.) — completion site (F1/S1) — pending
- Also fix `ios/PasswdSSOApp/Vault/HostSyncService.swift:140` (`fetchTeamMemberships`) `DPoP`→`Bearer`. (Team sync still won't reach its handler until C12; the scheme fix is the I1-correctness part and the error degrades gracefully via `?? []`.)

### C10a — basePath-safe resource URLs + htu (F2/F7) — pending
- **Problem**: `URL(string: "/api/...", relativeTo: serverURL)` drops `serverURL`'s basePath (`/passwd-sso`). `fetchEntries`/`fetchTeamEntries` build URLs this way → 404 + DPoP htu mismatch (`canonicalHTU` then computes the wrong htu).
- **Contract**: all iOS resource URLs are built with `serverURL.appending(path:)` + `URLComponents` for query (the pattern `fetchVaultUnlockData` already uses), so basePath is preserved. `canonicalHTU(url:)` of the resulting URL equals the server's `canonicalHtu({route})` under basePath.
- **Sites**: `MobileAPIClient.fetchEntries` (`:321`), `fetchTeamEntries` (`:279`), and `EntryFetcher.fetchPersonal` (`:136`) if it builds the path string.
- **Acceptance**: on a `/passwd-sso` deployment, `GET /passwd-sso/api/passwords?include=blob` is requested (not `/api/passwords`) and DPoP verify passes.

### C10b — Entry blob model shape (F3/F5/F6) — pending
- **Problem**: server personal blobs (`src/lib/vault/personal-entry-payload.ts`) do NOT contain `id` or `urlHost`, send `null` for empty `username`/`url`/`notes`, and omit `additionalUrlHosts` when empty. iOS `VaultEntrySummary`/`VaultEntryDetail` declare these non-optional → JSONDecoder fails → all entries silently dropped (`try?`).
- **Contract**: iOS entry models match the actual server blob shape exactly:
  - `id` is NOT decoded from the blob — it is injected from `CacheEntry.id` (pass `entryId` into `decryptSummary`/`decryptDetail`).
  - `username`/`url`/`notes` are `String?` (server sends `null`).
  - `urlHost` optional in detail (only in overview blob); `additionalUrlHosts` decoded with `decodeIfPresent ?? []`.
- **Consumer walkthrough**: `CredentialResolver` (ios/Shared/AutoFill/CredentialResolver.swift:330,354) reads `{title, username, urlHost, additionalUrlHosts}` from summary and `{password, totp, username, url, notes}` from detail; AutoFill needs `id` (from CacheEntry, not blob) to map back to the cache row. The host VaultListView/EntryDetailView read the same. All needed fields are satisfiable once `id` is injected and nullable fields are optional.
- **Acceptance**: a server-generated personal entry (with empty url/notes and no additionalUrlHosts) decodes and decrypts; entries appear in the list and detail.

### C10c — TOTP field shape (F4) — pending
- **Contract**: `VaultEntryDetail` decodes `totp: TOTPPayload?` where `TOTPPayload = { secret: String, algorithm: String?, digits: Int?, period: Int? }` (matching `src/lib/vault/entry-form-types.ts`), replacing the flat `totpSecret: String?`. TOTP code view derives from `totp.secret`.
- **Acceptance**: an entry with a server-stored TOTP shows a code.

### C11 — Remove diagnostics + guard (S6/T9) — pending
- Remove all `PSSO_DIAG` `NSLog` lines (AuthCoordinator, MobileAPIClient, VaultUnlocker). Add a lightweight repo grep guard (script or pre-PR check) so they cannot reappear. Forbidden pattern listed below.

### C12 — Team vault read over Bearer — DEFERRED (out of scope this pass)
- `EXTENSION_TOKEN_ROUTES` (server bearer-bypass) does NOT include `TEAMS`; the browser extension/CLI do not read team passwords via Bearer either. Supporting iOS team read requires extending the server bearer-bypass surface + token scope — a separate, security-sensitive change. Out of scope here; this pass targets PERSONAL vault end-to-end.
- Tracked: `TODO(ios-host-server-integration): team vault read over Bearer/DPoP — extend EXTENSION_TOKEN_ROUTES + scope`. iOS team-sync errors already degrade gracefully (`?? []`), so deferring does not crash the app.

### C13 — Regression tests for the fixed contracts (T1–T11) — pending
- C13.1 (T1/RT1): refactor `VaultUnlockerTests` to inject a `VaultUnlockAPIClient` protocol and test the REAL `VaultUnlocker.unlock` (not a re-implemented stub). A revert to `Data(base64Encoded:)` must turn a test red.
- C13.2 (T2/T3/RT3): update `MobileAPIClientTests`/`VaultViewModelTests`/`EntryFetcherTests` + postCacheRollbackReport test to assert `Bearer ` for resource calls; add `fetchTeamMemberships` scheme test; add a `refreshToken` test asserting `DPoP ` (T11/RT4).
- C13.3 (T4/RT2): add `extension/test/fixtures/vault-unlock-fixture.json` generated by the web `crypto-client` path; iOS test feeds it to the real `VaultUnlocker` and asserts the derived secret key.
- C13.4 (T5): `canonicalHTU` basePath test (iOS) + server `canonicalHtu` parity assertion.
- C13.5 (T6): fix `EntryFetcherTests` IV fixtures to 12-byte (24-hex). Add a server-faithful entry-blob decode+decrypt test (C10b/C10a regression).
- C13.6 (T7): personal-entry AAD round-trip test (web-encrypt → iOS-decrypt; wrong userId fails) + unlock `userId` → entry-AAD flow.
- C13.7 (T9/T10): PSSO_DIAG grep guard; proxy test that `/api/mobile/authorize` + Bearer does NOT bypass the session gate (best-effort).

## Invariants
- I1: No iOS request to an `authOrToken`/`validateExtensionToken`-protected route uses the `DPoP` Authorization scheme (must be `Bearer`). Only `/api/mobile/token/refresh` uses `DPoP`.
- I2: Every web-originated encrypted field is decoded with `hexDecode` on iOS, never `Data(base64Encoded:)` (except genuine base64url JWT/JWK in `CryptoUtils`).
- I3: `withBypassRls` never nests inside `withUserTenantRls`/`withTenantRls`.
- I4: Server-side redirects from API route handlers derive origin/basePath from env (`getAppOrigin`/`resolveBasePath`), never from `req.nextUrl` host.
- I5: API-route callbackUrls are never routed through the next-intl localized router.
- I6: iOS token path enforces tenant IP access restriction (in the route handler, since the proxy session gate is bypassed).

## Forbidden patterns (grep keys for conformance)
- pattern: `PSSO_DIAG` — reason: temporary diagnostic logging must not ship.
- pattern: `"DPoP \(accessToken)"` — reason: access-token requests must use Bearer (C9/I1).
- pattern: `Data(base64Encoded: unlockData\.` — reason: web fields are hex (C8/I2).
- pattern: `withBypassRls` inside a `withUserTenantRls`/`withTenantRls` callback — reason: I3 (manual/AST check, not pure grep).
- pattern: `associated-domains` in `ios/project.yml` — reason: custom-scheme replaced Universal Links (C1).

## Testing strategy
- **Server (vitest)**: authorize route (302 to scheme / sign-in redirect / IP-denied / step-up), route-policy classification (mobile/authorize = api-default), api-route proxy (no session gate on mobile/authorize), callback-url `isApiCallbackUrl`. All green at C8 (11090 tests).
- **iOS (XCTest)**: VaultUnlocker hex path; **C9 must update** `MobileAPIClientTests`/`VaultViewModelTests` that assert `DPoP ` scheme → assert `Bearer ` for resource calls, keep `DPoP ` for refresh. Add a regression test per confirmed C10 mismatch (encoding/AAD) where unit-testable.
- **Manual device (the gap that hid every bug)**: full chain on a real device against the self-hosted server. Each step that fails becomes a contract.
- `next build` typecheck after every server change.

## Considerations & constraints
- Argon2id vaults: out of scope (documented gap in C8). If the operator's vault is Argon2, iOS cannot unlock until an Argon2id impl is added.
- `npm ci` + `npx prisma generate` are environment prerequisites (stale `@simplewebauthn` 9→11 and wiped Prisma client broke `vitest`/`next build`); document in the deviation log, not a code change.
- Deployment: server changes require redeploying the self-hosted server (`git pull && rm -rf .next && npm run dev`, or container rebuild for standalone) — the running server, not the local worktree, serves the device.

## User operation scenarios
1. Fresh install → enter self-hosted URL (`https://<host>/<basePath>`) → Sign in → passkey (Face ID) → passphrase → vault list → entry detail (reveal password, TOTP) → edit a personal entry.
2. Self-hosted server on a non-public host (Tailscale `.ts.net`) behind a reverse proxy that forwards to an internal `localhost:PORT` Next dev server (origin/host must come from env, not request).
3. Token expiry mid-session → refresh (DPoP scheme) → resume.

## Go/No-Go Gate
| ID  | Subject                                                        | Status |
|-----|---------------------------------------------------------------|--------|
| C1  | Custom-scheme OAuth callback                                  | locked |
| C2  | Bundle/App Group/keychain rename                              | locked |
| C3  | Proxy classification + handler IP restriction                | locked |
| C4  | WebAuthn callbackUrl locale fix                               | locked |
| C5  | basePath-qualified callbackUrl (superseded by C6)            | locked |
| C6  | env-origin sign-in redirect                                  | locked |
| C7  | RLS nesting fix                                              | locked |
| C8  | Vault unlock hex + kdfType Int                              | locked |
| C9  | iOS Authorization Bearer scheme (incl. HostSyncService:140)  | done |
| C10a| basePath-safe resource URLs + htu                           | done |
| C10b| Entry blob model shape (shared EntryBlobDecoder, optional fields) | done |
| C10c| TOTP field shape                                            | done |
| C11 | Remove PSSO_DIAG diagnostics                                | done |
| C12 | Team vault read over Bearer — DEFERRED (TODO tracked)       | deferred |
| C13 | Regression tests (T1–T11)                                   | done |

### Device-discovered contracts (found only by on-device testing; all done, commit 7bcb2698)
| ID  | Subject                                                              | Status |
|-----|---------------------------------------------------------------------|--------|
| C14 | NSFaceIDUsageDescription (LAContext hard-crash without it)           | done |
| C15 | BridgeKeyStore default keychain access group (TEAMID/App-Group id were unentitled on device → unlock failed) | done |
| C16 | Use sync's in-memory CacheData (read-after-write raced fresh bridge-key counter → first-unlock empty list) | done |
| C17 | VaultListView owns VaultViewModel via @State (inline model replaced empty on foreground re-sync → "No entries") | done |
| C18 | password/url/notes/username optional in detail decode (non-LOGIN entries stuck on "decrypting") + retry state | done |
| C19 | UX: lock → passphrase screen (not URL setup), keeps config+token; URL pre-fill; unlock spinner through initial sync | done |

Note: AutoFill extension (section A), Universal Link OAuth on the public host, and the side-channel/adversarial scenarios (C/D) remain per the original verification-status doc. This pass delivered the personal-vault host-app read path (B9–B10) end-to-end on a real device.
