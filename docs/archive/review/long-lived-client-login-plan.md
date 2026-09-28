# Plan: long-lived-client-login

Branch: `feature/long-lived-client-login`

## Project context

- Type: `mixed` — Next.js web app + API (server), Chrome MV3 extension (`extension/`), iOS app (`ios/`).
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest server + extension, real-DB integration `npm run test:integration`, Playwright E2E, XCTest for iOS).
- Verification environment constraints:
  - **VE1** — iOS: no Xcode/simulator on the Linux dev host. Swift changes are verified by CI (`ios` workflow) and manually on the macOS host (mrx33). Classification per contract below.
  - **VE2** — Face ID/Touch ID requires a physical device or simulator enrollment; the biometric path is `verifiable-CI` only for the non-ACL logic (unit tests with an injected keystore), the ACL gate itself is `blocked-deferred` to manual test on device.
  - **VE3** — MV3 service-worker termination cannot be forced deterministically in unit tests; the "token survives SW restart" path is verified by unit tests on the hydrate logic (`verifiable-local`) plus a manual test via `chrome://serviceworker-internals` → Stop (`verifiable-local`, manual).

## Objective

Keep users logged in on the browser extension and iOS app for long periods while the vault still auto-locks after inactivity. Today, "lock" is effectively "logout" on the extension (token lost ~30 s after lock when the SW terminates) and the extension login is capped by the 8 h web-session idle; iOS forces re-login 7 days after first sign-in regardless of activity.

Security posture after the change: the login token's lifetime is bounded by **time since the last server-verified vault unlock (presence)** plus a family absolute cap, not by background refresh activity; tenants can force logout-on-timeout.

## Requirements

Functional:
- FR1 (E1) Extension token refresh does not require an Auth.js web session.
- FR2 (E2a) Extension token survives service-worker termination within one browser session; the vault secret key does NOT.
- FR3 (E3) Extension vault auto-lock is an inactivity timer.
- FR4 (A) Extension and iOS token families expire when `now − lastPresenceAt > idle`, where presence is recorded only by a successful server-side `authHash` verification. On the extension that requires the passphrase (the secret key does not survive lock). On iOS it requires the passphrase or the biometric ACL (C7) — so for iOS the worst-case re-authentication ceiling for a daily Face ID user is the absolute cap, not idle; C12 states this.
- FR5 (I1) iOS token idle/absolute are enforced on refresh and are tenant-configurable (same fields as extension).
- FR6 (B) Tenant can require `logout` as the vault-timeout action for extension and iOS.
- FR7 Docs updated (see C12).

Non-functional:
- No new durable secret on disk in the extension (E2b rejected).
- No change in defaults that shortens existing tenants' effective session in the steady state beyond the documented migration effect (C9).

## Decisions (agreed with the user)

- D1 Reuse `extensionTokenIdleTimeoutMinutes` / `extensionTokenAbsoluteTimeoutMinutes` (defaults 7 d / 30 d). Idle is **redefined** as "time since last verified unlock". No new idle field.
- D2 iOS uses the same two tenant fields (iOS absolute moves 7 d → tenant value, default 30 d; iOS idle moves from unenforced 24 h to enforced presence 7 d). iOS **access-token** TTL stays 24 h (`IOS_TOKEN_IDLE_TIMEOUT_MS` renamed to access TTL semantics — see C8).
- D3 Presence proof = the existing `authHash` (SHA-256 of HKDF(secretKey,"passwd-sso-auth-v1")), verified against `masterPasswordServerHash` exactly as `POST /api/vault/unlock`. On iOS, biometric unlock cannot recompute it (only the encryption key is wrapped), so the `authHash` is additionally wrapped under the biometric-ACL bridge key at passphrase unlock (C7). A Secure-Enclave signature was rejected: the existing SE DPoP key has no biometric ACL, so its signature does not prove presence.
- D4 E2b (disk persistence) rejected: IndexedDB is not OS-protected; cookies are.

## Technical approach

### Server

- New route `POST /api/vault/unlock/verify` — bearer (extension / iOS token, DPoP-bound) only. Body `{ authHash }`. Verifies via a compare helper extracted from `/api/vault/unlock` (C1). On success, records presence for the presenting token's family (C2). Unlike web unlock, a wrong hash here does **not** feed account lockout (S1: a token holder without the passphrase must not be able to lock the owner out); it is rate-limited per token family and audited. Web `/api/vault/unlock` switches to the same compare helper and keeps its lockout behaviour.
- Presence storage: new nullable column `ExtensionToken.lastPresenceAt` (DateTime). Presence write = single-row update on the **presenting token row** (no `revokedAt` filter). Presence read = `MAX(lastPresenceAt)` over all rows of the family still present in the table, falling back to `familyCreatedAt` when all are null (C9). Rotation copies the family max into the new row. This avoids a rotation-vs-presence lost-update race without a lock: a presence write that lands on a just-revoked row is still counted by the MAX read. (Rows are GC'd only after `expires_at` passes, `src/workers/retention-gc-worker/registry.ts` `extension_tokens` rule.)
- Effective expiry for every issued/rotated row: `expiresAt = min(now + idle, presence + idle, familyCreatedAt + absolute)` (C3). Refresh rejects (and revokes family, reason `presence_expired`) when `presence + idle ≤ now`.
- Extension refresh: remove the `prisma.session` lookup; tenantId comes from the token row. Add replay detection: presenting an already-revoked token to the refresh route more than `REFRESH_REPLAY_GRACE_MS` after its `revokedAt` → revoke family (reason `replay_detected`) + audit.
- Audit: no new `AuditAction` values. Wrong hash on C2 → `VAULT_UNLOCK_FAILED` (metadata `{ source: "client_token", clientKind }`); presence-expiry and replay family revocations → existing `EXTENSION_TOKEN_FAMILY_REVOKED` with `metadata.reason`, emitted by the shared `revokeExtensionTokenFamily` for both clients (iOS already routes its family revokes through it). The audit-log UI's `VAULT_UNLOCK_FAILED` detail line reads `metadata.attempts`; client-token rows carry none and show no detail (G3, accepted; C12 notes it). Successful verify → structured log only (same as web unlock success).
- Tenant policy: new column `Tenant.requireVaultTimeoutLogout Boolean @default(false)`; exposed in `GET/PUT /api/tenant/policy`, the session-policy card, and delivered to clients in `GET /api/vault/unlock/data` next to `vaultAutoLockMinutes`.

### Extension

- `session-storage.ts`: `token` stored in `chrome.storage.session` without the ephemeral-key wrapping; `vaultSecretKey` keeps it. Hydrate restores the token (and refresh alarm) when the SW restarts; vault stays locked if the ephemeral key is gone.
- Unlock: after local verification succeeds, compute `authHash` (new `deriveAuthKeyBytes` + `computeAuthHash` in `extension/src/lib/crypto.ts`, byte-identical to `src/lib/crypto/crypto-client.ts`, pinned by a shared golden vector) and `POST /api/vault/unlock/verify`. A verify failure never blocks the local unlock (the local GCM/artifact check already proved the passphrase); it only means presence was not recorded. 422 `AUTH_HASH_MISMATCH` from verify (hash mismatch after a successful local unlock — e.g. server hash rotated) is logged and surfaced as a non-blocking warning; a 401 (token/DPoP layer) is logged as a token failure, not a hash mismatch. No failure notice is sent on local passphrase failure (S1).
- Auto-lock alarm re-armed on user activity (C6).
- Tenant `requireVaultTimeoutLogout` overrides local `vaultTimeoutAction`.
- Refresh single-flight: module-level `inflightRefresh: Promise<boolean> | null` in the background; every refresh caller (alarm, lazy expiry check, 401 retry) awaits the same promise. SW termination drops the promise together with the request, so no cross-restart state is needed; a request lost mid-flight is covered by the C5 grace window only if retried within it, otherwise the next refresh uses the old token and fails closed (reconnect).

### iOS

- On passphrase unlock: compute authHash (new `computeAuthHash(authKey:)` in `ios/Shared/Crypto/KDF.swift`, same golden vector), call verify, and wrap authHash under the bridge key (new file in `WrappedKeyStore`). On biometric unlock: unwrap authHash (same LAContext) and call verify (best-effort when offline — presence not recorded, vault still unlocks locally).
- Tenant `requireVaultTimeoutLogout` overrides local action.
- `authHash` wrapped blob deleted on sign-out and when the bridge key is invalidated.

## Contracts

### C1 — Shared authHash verifier
- Signature: `compareVaultAuthHash(authHash: string, stored: { masterPasswordServerHash: string; masterPasswordServerSalt: string }): boolean` in `src/lib/vault/verify-auth-hash.ts` — pure, `timingSafeEqual`, length-mismatch → false. Callers own lockout/rate-limit policy.
- Invariants: single compare implementation (R48). Member-set (`for f in $(rg -l masterPasswordServerSalt src -g '*.ts' | grep -v test); do echo $f $(grep -c timingSafeEqual $f); done`): compare sites = `src/app/api/vault/unlock/route.ts`, `src/app/api/vault/rotate-key/route.ts` (current-passphrase check); both switch to `compareVaultAuthHash`; unlock keeps its lockout + limiter, rotate-key keeps its route limiter (it has no lockout today and gains none). Salt writers without a compare: `setup/route.ts`, `src/lib/vault/vault-reset.ts`, `src/lib/vault/rotate-key-server.ts`. Web `/api/vault/unlock`: lockout check → per-user limiter `rl:vault_unlock:${userId}` → compare → `recordFailure` / `resetLockout` (unchanged behaviour). C2: `checkLockout` (read-only; a locked account cannot record presence) → per-family limiter `rl:vault_unlock_verify:${familyId}` 5 / 5 min → compare → no `recordFailure`, no `resetLockout`.
- Control class: `enforceable boundary` for "presence cannot be recorded without knowledge of authHash"; adjudication authority: SHA-256(authHash+serverSalt) compare against `masterPasswordServerHash`.
- Forbidden patterns: `pattern: createHash\("sha256"\)[\s\S]{0,80}masterPasswordServerSalt — reason: only C1 may compute the server hash` (outside `verify-auth-hash.ts`).
- CI gate (T6): `check-crypto-domains.mjs` new Check G — `masterPasswordServerSalt` together with `timingSafeEqual` in one file is allowed only in `src/lib/vault/verify-auth-hash.ts`; the salt writers listed above do not call `timingSafeEqual` and are unaffected; `rotate-key/route.ts` passes only after its C1 migration. Red-proof: a bypassing fixture for each of `unlock/route.ts` and `rotate-key/route.ts` (re-inlined compare) fails the check. Control class: `best-effort tripwire` (lexical).
- Acceptance: `/api/vault/unlock` and `/api/vault/rotate-key` route tests unchanged and green; both routes and C2 use C1.

### C2 — `POST /api/vault/unlock/verify`
- Auth: `checkAuth(req, { scope: VAULT_UNLOCK_DATA })`, then an explicit `authResult.auth.type === "session"` → 401 (authOrToken tries the session first and applies no scope to it — `src/lib/auth/session/auth-or-token.ts`). Only `extension_token` results with `clientKind ∈ {BROWSER_EXTENSION, IOS_APP}` proceed (`IOS_AUTOFILL` → 403). DPoP is enforced by `validateExtensionToken` for both kinds.
- Control class: `enforceable boundary` — presence cannot be recorded without (a live, DPoP-bound client token) ∧ (knowledge of authHash); adjudication authority: `validateExtensionToken` + C1 compare.
- Body (Zod strict): `{ authHash: hexHash }`. Response: `200 { verified: true }` / `422 { error: "AUTH_HASH_MISMATCH" }` (new `API_ERROR` code; 422 is unique among this route's responses — app-wide it is shared with `MCP_CLIENT_LIMIT_EXCEEDED`, so any 422-rate alert must be path-scoped, which C12 states) / `403 ACCOUNT_LOCKED` / `429`. A 401 from this route therefore always means a token/DPoP-layer failure, and every outcome is distinguishable by status alone (I1: `MobileAPIClient` has no 401-body parsing). A mismatch stays a 4xx so status-based infra monitoring still sees guessing (R6-S1); the web route keeps `401 { valid: false }` — C12 documents that the two entry points signal a wrong hash with different statuses and that the audit stream (`VAULT_UNLOCK_FAILED`, `metadata.source`) is the cross-route signal.
- New error code touches: `API_ERROR`, `API_ERROR_STATUS` (422), `API_ERROR_I18N` in `src/lib/http/api-error-codes.ts`, `messages/{en,ja}` error strings (`src/__tests__/api-errors-i18n-coverage.test.ts` enforces), `api-error-codes.test.ts`.
- Side effect on success: `extensionToken.update({ where: { id: <presenting token id> }, data: { lastPresenceAt: now } })` — nothing else. `expiresAt` is NOT recomputed here (G2: an iOS access row and refresh row are indistinguishable by column, and each has its own TTL semantics known only at issuance). The new presence takes effect at the next rotation through C4's MAX + C3. The extension's refresh alarm (≤ 2 min before expiry) and iOS's on-demand refresh reach that rotation before the current row expires, so no user-visible gap.
- Wrong hash → `422 AUTH_HASH_MISMATCH` + `VAULT_UNLOCK_FAILED` audit; no lockout counter.
- Proxy: new `API_PATH.VAULT_UNLOCK_VERIFY`; add `{ methods: M("POST"), match: exact(API_PATH.VAULT_UNLOCK_VERIFY) }` to `BEARER_RULES` (the enforcing allowlist) and to `BEARER_BYPASS_ROUTE_SUMMARY`; proxy test asserts a cookieless Bearer POST reaches the handler and a cookieless request without Bearer is rejected.
- Consumer walkthrough:
  - Extension background (`extension/src/background/index.ts` UNLOCK_VAULT) reads the status; 200 → presence recorded; 422 or any error is non-blocking (logged).
  - iOS `MobileAPIClient.verifyUnlock` returns `true` on 200, `false` on 422 (`serverError(status: 422)` from the mirrored ladder's default branch) → delete cached authHash; any error non-blocking (logged); network error → presence not recorded.
- Acceptance: presence recorded only on correct hash (row's `lastPresenceAt` changed, `expiresAt` unchanged); wrong hash → `422 AUTH_HASH_MISMATCH`, row unchanged and `accountLockedUntil`/failure counter unchanged; session-cookie-only request → 401 with row unchanged; `IOS_AUTOFILL` → 403; 6th wrong hash within 5 min on one family → 429 while another family of the same user is still allowed; account already locked (`checkLockout`) → `ACCOUNT_LOCKED`, limiter not consumed, compare not performed, row unchanged.

### C3 — Token expiry computation
- Signature: `computeClientTokenExpiry(p: { now: Date; presenceAt: Date; familyCreatedAt: Date; idleMinutes: number; absoluteMinutes: number }): Date` (pure) in `src/lib/auth/tokens/client-token-expiry.ts`.
- Invariant: result = min(now+idle, presenceAt+idle, familyCreatedAt+absolute). Used by extension issue, extension refresh, iOS issue, iOS refresh (C2 does not recompute). Member-set: `rg -n "expiresAt\s*=|expiresAt:" src/lib/auth/tokens/extension-token.ts src/lib/auth/tokens/mobile-token.ts src/app/api/extension/token src/app/api/mobile` — every client-token issuance/rotation site in that output uses C3; the non-members in the same output are `IOS_AUTOFILL` (5 min fixed, `mobile-token.ts`), the mobile bridge code (`src/app/api/mobile/authorize/route.ts`, `BRIDGE_CODE_TTL_MS`) and the favicon cache field (`src/app/api/mobile/favicon/route.ts`).
- Forbidden: `pattern: now\.getTime\(\) \+ idleMinutes \* MS_PER_MINUTE — reason: bypasses presence cap` in token issuance/refresh files. CI gate (T6): new `scripts/checks/check-client-token-expiry.mjs` (lexical-with-context, mirrors `check-count-then-create-lock.mjs`): every file under `src/` containing `extensionToken.create(` or an `extensionToken.update(` that writes `expiresAt` must import `computeClientTokenExpiry`, or be listed in an exemption set with a reason (`issueAutofillToken`'s fixed 5-min TTL lives in `mobile-token.ts`, which also imports the helper, so exemption is per-file not per-call — declared residual). Exemptions in `scripts/checks/client-token-expiry-exemptions.txt` (`path # reason`, like `raw-sql-usage.txt`). Self-test at `scripts/__tests__/check-client-token-expiry.test.mjs` (required by `check-gate-selftest-coverage.sh`; no `gate-selftest-debt.txt` entry): a bypassing fixture (writes `expiresAt` from `now.getTime() + idleMinutes * MS_PER_MINUTE`, no helper import) must fail, a conforming fixture must pass. Wired into `scripts/pre-pr.sh` and the static-checks CI job. Checks F/G get `describe` blocks in the existing `scripts/__tests__/check-crypto-domains.test.mjs`. Control class: `best-effort tripwire` (lexical; a helper-wrapped write in another file is a known bypass).
- Acceptance: unit table tests at the three boundaries.

### C4 — Presence read + refresh gate
- Signature: `getFamilyPresenceAt(tx, familyId: string, familyCreatedAt: Date): Promise<Date>` = MAX(last_presence_at) over family rows, else familyCreatedAt.
- Refresh (extension and iOS) rejects with `EXTENSION_TOKEN_SESSION_EXPIRED` (extension) / the existing iOS refresh-failure response and revokes the family (audit `EXTENSION_TOKEN_FAMILY_REVOKED` via `revokeExtensionTokenFamily`, `metadata.reason = "presence_expired"`) when `presence + idle ≤ now` (boundary: equality expires).
- New row carries `lastPresenceAt = presence` (the max).
- New member `PRESENCE_EXPIRED: "presence_expired"` in `EXTENSION_TOKEN_REVOKE_REASON` (`src/lib/auth/tokens/extension-token.ts`); `REPLAY_DETECTED` already exists.
- Control class: `enforceable boundary` against a token outliving presence; adjudication authority: DB row timestamps via C4 + C3.
- Acceptance (real-DB integration, deterministic sequence — no timing race, T1): (1) create family row A; (2) rotate A → B (A revoked, B carries presence p0); (3) write `lastPresenceAt = p1 > p0` directly on revoked A; (4) `getFamilyPresenceAt` returns p1 and the next refresh of B succeeds past `p0 + idle`. Red-proof: adding a `revokedAt: null` filter to the MAX query must turn (4) red.

### C5 — Extension refresh decoupled from web session + replay detection
- Remove `prisma.session.findFirst` in `src/app/api/extension/token/refresh/route.ts`; tenant from `token.tenantId` (fail closed if the tenant row is missing, as issuance does). What the session lookup incidentally provided and must stay covered: active tenant membership / deactivated user (already in `validateExtensionToken`), tenant id (token row). Tenant IP restriction already keys off the validated token row (`enforceAccessRestriction(req, userId, tenantId)` with `tenantId` from `validateExtensionToken`), so it is unaffected. The tenant-policy read (idle/absolute) moves from `activeSession.tenantId` to the token row's `tenantId` — the tenant the family was issued under. This is safe only because `validateExtensionToken` rejects a token whose `TenantMember(token.tenantId, userId)` is missing or deactivated, and `resolveUserTenantIdFromClient` (`src/lib/tenant-context.ts`) forbids more than one active membership — so a tenant move kills the pinned token outright. Any future change allowing multiple active memberships must re-examine C5. Acceptance adds: IP-restricted tenant + disallowed IP → refresh denied with no session row present.
- Replay: `ExtensionToken` has no revoke-reason column (only `revokedAt`), and a family is one device, so the rule does not branch on why the row was revoked. In the refresh route, a presented token whose `revokedAt < now − REFRESH_REPLAY_GRACE_MS` → `revokeExtensionTokenFamily(reason: "replay_detected")`; the audit `EXTENSION_TOKEN_FAMILY_REVOKED` with `metadata.reason = "replay_detected"` is emitted only when that call revoked ≥ 1 live row (i.e. the family was still alive — the rotation-replay case). A family already dead (logout, overflow, sign-out-everywhere) is a no-op without audit. Within the grace window → `EXTENSION_TOKEN_REVOKED` without family revoke. Requires the refresh route to look the token up itself (validateExtensionToken returns early on revoked).
- Revocation of the extension on web sign-out: unchanged (sign-out-everywhere revokes all; single-session logout no longer affects the extension — documented).
- Control class: replay detection = `detection or audit only` + family revoke (best-effort tripwire: an attacker who refreshes first wins until the legitimate client replays).
- Acceptance: refresh succeeds with no web session; replay after grace revokes family; replay within grace does not.

### C6 — Extension inactivity auto-lock
- Activity sources (reset `ALARM_VAULT_LOCK` to `now + effectiveLock`, debounced ≥ 30 s): messages from extension pages (`sender.url` starts with `chrome.runtime.getURL("")` — popup, options), `chrome.commands` events, context-menu clicks, and content-script fill/copy requests that the content script only sends from a trusted user gesture (`event.isTrusted`). Messages a page can trigger without a trusted gesture do not count.
- Control class: `best-effort tripwire` for "a web page cannot keep the vault unlocked" — known bypass: an extension-context attacker; recovery: tenant auto-lock max + presence idle.
- Acceptance: activity at t=14 min with 15 min lock → not locked at 16 min; page-originated untrusted message does not extend.

### C7 — iOS presence
- `MobileAPIClient.verifyUnlock(authHash:) async throws -> Bool` → C2, using the same 401 ladder as the other authenticated calls (nonce retry → `TokenRefreshCoordinator` refresh → rebuild `ath` → retry once). Add a shared `performAuthedPOST` that is a straight mirror of `performAuthedGET` (status/header-driven ladder, returns `Data`) rather than a fourth hand-rolled copy (existing POSTs are not migrated — out of scope). No body inspection is needed: C2 never returns 401 for a hash mismatch, so the 422 falls to the default (thrown) branch and never enters the ladder. Needed because after a day away the 24 h access token has usually expired by the next Face ID unlock (H1); presence is "not recorded" only after the ladder fails.
- `WrappedKeyStore.saveAuthHash/loadAuthHash/deleteAuthHash` — wrapped under the same HKDF(bridge_key) cacheKey as the vault key, bound to userId. Conformers to update: `AppGroupWrappedKeyStore` (`ios/Shared/Storage/WrappedKeyStore.swift`), `TempDirWrappedKeyStore` (`ios/PasswdSSOTests/WrappedKeyStoreTests.swift`), `MockWrappedKeyStore` (`ios/PasswdSSOTests/CredentialResolverTests.swift`).
- `computeAuthHash(authKey:)` added to `ios/Shared/Crypto/KDF.swift` (SHA-256 of `deriveAuthKey`), golden-vector test shared with web and extension.
- Stale cached authHash: `change-passphrase` does not change secretKey/server hash, so the cache stays valid; `rotate-key` changes the server hash but also revokes all client tokens (`invalidateUserSessions`), forcing sign-in — the cache is overwritten on the next passphrase unlock. Only a 422 deletes the cached authHash; any thrown error (401 ladder exhausted, network, 429, lock) leaves it untouched (XCTest asserts both).
- Passphrase unlock: derive authKey → authHash, wrap, verify. Biometric unlock: unwrap authHash in the same LAContext evaluation (no second prompt), verify best-effort.
- Invariant: authHash plaintext zeroed after use; deleted with bridge key on sign-out / biometric set change.
- Acceptance: XCTests with injected keystore/API stub (`verifiable-CI`); Face ID ACL on device (`blocked-deferred`, VE2, manual test M4).

### C8 — iOS tenant-configurable lifetimes
- `IssueIosTokenParams` gains `idleMinutes`, `absoluteMinutes`, `presenceAt`; callers (`src/app/api/mobile/token/route.ts`, `refreshIosToken`) read the tenant's `extensionTokenIdleTimeoutMinutes` / `extensionTokenAbsoluteTimeoutMinutes` (fail closed on missing tenant). `refreshIosToken` gains a tenant-policy read. Access-token TTL constant renamed `IOS_ACCESS_TOKEN_TTL_MS` (24 h, capped by C3) — importers: `mobile-token.ts`, `src/app/api/mobile/token/route.ts`, `src/app/api/mobile/token/refresh/route.ts` (`expires_in`), `mobile-token.test.ts`. `IOS_TOKEN_ABSOLUTE_TIMEOUT_MS` removed. Refresh-row `expiresAt` = C3 (not the absolute); `expires_in` = access row's C3-capped expiry − now.
- `refreshIosToken` enforces C4.
- Acceptance: family older than tenant absolute → revoked; presence older than idle → revoked, with the audit row asserted as `EXTENSION_TOKEN_FAMILY_REVOKED` / `metadata.reason = "presence_expired"`; active use with periodic unlocks → survives past 7 d.

### C9 — Migration semantics
- Migration: `ALTER TABLE extension_tokens ADD COLUMN last_presence_at timestamptz NULL`; `ALTER TABLE tenants ADD COLUMN require_vault_timeout_logout boolean NOT NULL DEFAULT false`. Additive only (R24). Grants: `scripts/checks/db-grants-manifest.json` — both tables carry table-level grants for `passwd_app`, so no manifest change is expected; Phase 2 runs `audit-db-grants.mjs` to confirm (R14). No `AuditAction` enum change.
- Null presence ⇒ `familyCreatedAt` (C4). Consequence: at deploy, families older than idle (7 d) are cut on next refresh — documented in release notes.
- Old extension/iOS builds that never call C2 are cut `idle` after family creation (acceptable: old extension already loses its token on SW termination).

### C10 — Tenant `requireVaultTimeoutLogout`
- `GET/PUT /api/tenant/policy` field `requireVaultTimeoutLogout: boolean`; audit via the existing policy-update audit; UI switch in `tenant-session-policy-card.tsx` (en/ja messages).
- Delivered wherever `vaultAutoLockMinutes` is delivered. Member-set (`rg -ln "vaultAutoLockMinutes" src/app/api | grep -v test`): `src/app/api/vault/unlock/data/route.ts`, `src/app/api/vault/status/route.ts` (client delivery), `src/app/api/tenant/policy/route.ts` (admin CRUD). All three get the field.
- Clients: effective action = `logout` if tenant flag true, else local setting; local UI disables the selector with an explanation.
- Consumer walkthrough: extension background reads `requireVaultTimeoutLogout` from unlock/data and caches it like `tenantAutoLockMinutes`; the alarm handler uses it. iOS `AppSettingsStore` persists it on passphrase unlock like `tenantAutoLockMinutes`; `AutoLockService` uses it.
- Control class: `enforceable boundary` only against the user's local setting (client-enforced; an extension-context attacker can bypass) — documented as client-side policy like `vaultAutoLockMinutes` (`docs/security/policy-enforcement.md`).

### C11 — Extension token persistence split (E2a)
- `session-storage.ts`: persisted shape `{ token: string (plain), expiresAt, userId, tenantAutoLockMinutes, requireVaultTimeoutLogout, tokenCnfJkt, personalKeyVersion, vaultSecretKey?: EncryptedField }`.
- Hydrate: if token present and `expiresAt > now` and cnfJkt matches IDB DPoP key → restore token + refresh alarm; vault restored only when `decryptField(vaultSecretKey)` succeeds.
- `chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` remains and is asserted in a test.
- Control class: `enforceable boundary` against web pages and content scripts (Chrome access level); **accepted exposure**: any trusted extension context (popup, options, offscreen document) can read the plain token. The token cannot be ephemeral-key-wrapped because surviving SW death is the requirement; DPoP (non-extractable key in IDB, extension origin) is the compensating control against exfiltration, and an attacker already executing in a trusted extension context can use the live in-memory token today. `vaultSecretKey` keeps the wrapping because it must NOT survive SW death.
- Forbidden: `pattern: chrome\.storage\.local\.set\([^)]*token — reason: token must never reach disk`.
- Acceptance: unit test — ephemeral key lost (new module instance) → token restored, vault locked.

### C12 — Docs
- `docs/architecture/client-reauth-timing.md` rewritten for the new model (and fix iOS 24 h/7 d, picker 5–60 inaccuracies); `docs/security/considerations/en.md` §1.5/§14 (and ja if present); `docs/security/session-timeout-design.md` (idle = presence); `docs/architecture/extension-token-bridge.md` lifecycle table; `docs/architecture/ios-app.md` TTLs; deployment guidance recommending Chrome policy `DeveloperToolsAvailability=2` for managed fleets; fix the "cannot be used for brute-force" comment above `vaultUnlockDataLimiter` in `src/app/api/vault/unlock/data/route.ts` (the data enables offline verification; brute-force resistance is PBKDF2 cost, not secrecy).

## Testing strategy

- Unit (vitest): C1 compare (match / mismatch / length mismatch); C2 route (acceptance list above, both allow and deny with mutation asserted); C3 table at each boundary; C4 fallback; C5 replay grace boundaries (at exactly grace = no family revoke); C10 policy route validation; C11 hydrate; C6 activity reset + untrusted exclusion; extension background UNLOCK_VAULT consumer (`extension/src/__tests__/background.test.ts`): verify 200 → unlocked; 422 → still unlocked, mismatch warning logged; 401 (token/DPoP layer) / `ACCOUNT_LOCKED` / 429 / network error → each still unlocked with its own logged warning (one case per response); C10 alarm override (tenant flag true + local `lock` → token cleared).
- Golden vector: frozen in `scripts/checks/auth-hash-golden-vectors.json` (secretKey hex → authHash hex), mirroring `aad-golden-vectors.json`; web (`crypto-client`), extension (`crypto.ts`) and iOS (`KDFTests`) parity tests each assert it; `check-crypto-domains.mjs` new Check F verifies each parity test contains the frozen value (as Check D does for AAD).
- Existing tests to rewrite (not patch): `extension/src/__tests__/lib/session-storage.test.ts` — the "stores encrypted format (not token)", "returns null for old plaintext format", and "returns null when decryptField returns null" cases encode the old contract; replace with: token plain + vaultSecretKey wrapped; ephemeral key lost → token restored, vault null. `src/app/api/extension/token/refresh/route.test.ts` and `src/__tests__/api/extension/token-refresh-cnfJkt.test.ts` (two trees, independent `mockSessionFindFirst`) — both drop the session mock; the session-expired test becomes "refresh succeeds without a session". `src/lib/auth/tokens/mobile-token.test.ts` — fixtures parameterised on tenant idle/absolute instead of the removed constants.
- Integration (real DB): C4 deterministic sequence (above); C9 null fallback; C2 end-to-end with a real token row; extension refresh with no `sessions` row for the user succeeds (FR1, `verifiable-CI`).
- iOS XCTest: C7 (expired access token at verify → refresh then verify succeeds; passphrase unlock stores wrapped authHash; biometric unlock sends it; 422 → `loadAuthHash` returns nil afterwards and exactly one request, no refresh; token-layer 401 → cache kept), C8 client-side, and `AutoLockServiceTests` case: `requireVaultTimeoutLogout = true` + local action `lock` → signs out.
- Every new denial test asserts the mutation (family revoked / row unchanged), not only the status (RT8).
- Manual: M1 extension lock → stop SW (`chrome://serviceworker-internals`) → popup shows unlock, not Connect (VE3, `verifiable-local`); M2 extension keeps working after signing out of the web tab (smoke; FR1 is covered by the integration test); M3 tenant logout flag; M4 iOS Face ID unlock records presence (device); M5 presence expiry after shortening tenant idle to 5 min.

## Considerations & constraints

- Presence proof is the static `authHash` (password-equivalent for C2). Captured authHash → presence extension until passphrase change. Acceptable: capturing it requires the unlocked secret key or TLS interception; the web unlock already relies on it.
- C2 does not feed account lockout (S1). Consequence: online guessing through the extension/iOS UI is bounded by the per-family limiter (5 / 5 min) rather than the lockout ladder — equal to today, where extension/iOS unlock is purely local and never counted.
- Offline brute force from `unlock/data` remains possible for any token holder; unchanged, documented.
- Single-session web logout no longer ends extension login (by design, E1).

### Scope contract
- SC1 E2b (persist token across browser restart) — rejected, no owner.
- SC2 E2c (step-up exemption for known cnfJkt) — deferred, future issue.
- SC3 Web app `requireVaultTimeoutLogout` semantics — web has no token/logout-on-lock concept; out of scope.
- SC4 Renaming `extensionToken*` policy fields to a client-neutral name — deferred (churn).

## User operation scenarios

- U1 Daily extension user: unlocks in the morning, auto-lock after 15 min idle, re-unlocks with passphrase only all week; Connect appears only after browser restart or 7 d without any unlock.
- U2 User who closes the laptop lid overnight with browser open: next morning vault locked, token alive (≤ 7 d presence) → passphrase only.
- U3 Walk-up attacker on unlocked OS with extension locked: token present; without passphrase cannot record presence; token dies ≤ 7 d after the last real unlock.
- U4 Tenant with `requireVaultTimeoutLogout`: auto-lock disconnects; next use requires Connect.
- U5 iOS user: Face ID unlocks daily → presence extended; family absolute 30 d forces sign-in monthly.
- U6 Offline iOS biometric unlock: works locally; presence not recorded; if offline > 7 d, next online refresh fails → sign in again.

## Go/No-Go Gate

| ID  | Subject                                          | Status  |
|-----|--------------------------------------------------|---------|
| C1  | Shared authHash verifier                         | locked  |
| C2  | POST /api/vault/unlock/verify                    | locked  |
| C3  | Token expiry computation                         | locked  |
| C4  | Presence read + refresh gate                     | locked  |
| C5  | Extension refresh w/o web session + replay       | locked  |
| C6  | Extension inactivity auto-lock                   | locked  |
| C7  | iOS presence                                     | locked  |
| C8  | iOS tenant-configurable lifetimes                | locked  |
| C9  | Migration semantics                              | locked  |
| C10 | Tenant requireVaultTimeoutLogout                 | locked  |
| C11 | Extension token persistence split                | locked  |
| C12 | Docs                                             | locked  |
