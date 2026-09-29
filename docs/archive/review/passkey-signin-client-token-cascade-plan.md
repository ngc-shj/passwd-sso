# Plan: passkey-signin-client-token-cascade

Branch: `fix/passkey-signin-client-token-cascade`

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16), with browser-extension and iOS clients.
- Test infrastructure: unit (vitest) + real-DB integration (`npm run test:integration`) + E2E (Playwright) + CI/CD.
- Verification environment constraints:
  - **VE1** — The iOS DPoP key lives in the Secure Enclave (`ios/Shared/Crypto/SecureEnclaveKey.swift`), so the iOS leg of the manual scenario needs a physical device. It is built on z1mn-island and run by the user. Classification: verifiable-local (user-operated).
  - **VE2** — The integration suite cannot share the dev database with the running `audit-outbox-worker` / `retention-gc-worker` (see CLAUDE.md). Stop them before `npm run test:integration`. Classification: verifiable-local.

## Objective

1. A passkey sign-in must not sign the user out of the browser extension or the iOS app, or revoke any other bearer credential. It should behave like the other sign-in paths.
2. The per-user active-client cap must count devices (token families), not rows, and must ignore the short-lived AutoFill token. Then one extension plus one iPhone fits with room to spare.

User decisions (2026-09-29): align passkey with the other sign-in paths (option "他の経路と揃える"), and handle item 2 on this branch.

## Background and the C7 decision being superseded

`owasp-batch-3` C7 changed `/api/auth/passkey/verify` from `revokeAllExtensionTokensForUser` to `invalidateUserSessions(user.id, { allTenants: true })`. The only rationale recorded was "passkey is a global authenticator (AAL3 re-establish)… match the credential's scope to prevent half-revoked state". No threat was named.

Why that rationale does not justify revoking on sign-in:

- A successful sign-in shows the signer has the credential. It shows nothing about whether any existing credential was compromised. Revoking on sign-in removes no attacker capability that the explicit paths below do not already remove, and an attacker who does hold the passkey uses it to sign the real user out of their devices.
- The other sign-in paths, measured: Google OIDC, SAML (Jackson OIDC) and Magic Link all create sessions through `createSession` in `src/lib/auth/session/auth-adapter.ts`. That function evicts only Web sessions over the tenant's `maxConcurrentSessions` cap and touches no bearer tokens. The `events.signIn` handler in `src/auth.ts` only writes an audit entry. Derivation: `grep -rn "session\.create(" src --include='*.ts' | grep -v test` returns exactly two sites, the adapter and the passkey route.
- Explicit recovery paths remain, and each revokes the kind it names:
  - `DELETE /api/sessions` (sign out everywhere): Web sessions and all extension/iOS tokens.
  - `DELETE /api/api-keys/[id]`: API keys.
  - `DELETE /api/user/mcp-tokens/[id]` and `POST /api/mcp/revoke`: MCP tokens.
  - `DELETE /api/vault/delegation[/id]`: delegation sessions.
  - `DELETE /api/tenant/operator-tokens/[id]`: operator tokens.
  - Every secret-changing operation calls `invalidateUserSessions` with all token models (member set in C2).

## Requirements

- Functional:
  - Passkey sign-in keeps other Web sessions (subject to the tenant cap) and all bearer tokens.
  - A new extension or iOS connection evicts only when the user already has `CLIENT_TOKEN_MAX_ACTIVE_FAMILIES` active device families other than AutoFill. The evicted unit is a whole family, the one with the oldest presence.
  - Reconnecting the same client install supersedes that install's previous family instead of consuming a slot. Both clients reuse their DPoP key across logins: extension IDB `dpop-keys/current` (`extension/src/lib/dpop-key.ts`), iOS Secure Enclave label (`AuthCoordinator.swift`, load-or-generate), so the same install presents the same `cnfJkt`.
  - Refresh never evicts another family.
- Non-functional: the count-then-evict-then-create sequence stays serialized per user. Every revocation of a family emits `EXTENSION_TOKEN_FAMILY_REVOKED` with a reason. Cap evictions previously emitted nothing.

## Technical approach

### Concurrency probe (plan-stage, real stack)

The cap relies on `advisoryXactLock(tx, userId)` inside `withUserTenantRls(userId, () => prisma.$transaction(...))`. Probe run on 2026-09-29 against the dev DB through the production client path, with the workers stopped:

- Probe: a throwaway integration test (deleted after the run). It ran 5 rounds of 10 concurrent `issueExtensionToken` calls for one user, counted active rows each round, and logged `current_setting('transaction_isolation')` from inside the same wrapper.
- With the lock: isolation `read committed`, active rows 3/3/3/3/3, pass.
- With `advisoryXactLock` mocked to a no-op (`PROBE_NO_LOCK=1`): active rows 10/10/10/8/11, fail ("expected 11 to be less than or equal to 3").
- Conclusion: the lock is what serializes the cap, and the wrapper does not drop it. The new family cap keeps the same primitive in the same transaction. The integration test in the Testing strategy keeps this probe as a permanent regression test that is able to fail.

## Contracts

### C1 — Shared capped Web-session creation

- New module `src/lib/auth/session/session-concurrency.ts`, extracted from `createSession` in `auth-adapter.ts`. The adapter's behaviour does not change, with one exception: eviction order.
  - Today eviction orders by `id asc`, but `Session.id` is `uuid(4)` (random), so "oldest" is arbitrary (F3-adj-1, pre-existing).
  - The helper orders by `createdAt asc, id asc` instead. `id` is only the tie-break for a total order (R57).
  - The advisory lock already serializes the path, so the old "consistent lock ordering" comment no longer applies.
  - `createSessionUnderConcurrencyCap(tx: Prisma.TransactionClient, input: CappedSessionInput): Promise<{ session: { userId: string; expires: Date }; eviction: SessionEviction | null }>`
    - `CappedSessionInput = { userId; tenantId; sessionTokenDigest; expires; ip: string | null; userAgent: string | null; provider: string | null; passkeyVerifiedAt?: Date; authCredentialId?: string }`
    - Body: `advisoryXactLock(tx, userId)`, then the tenant cap lookup (fail-closed on a missing tenant row), eviction of the oldest sessions, and `tx.session.create`. `tx.session.create` uses the unchecked input (scalar `userId` / `tenantId`), as the adapter does today.
  - `reportSessionEviction(eviction: SessionEviction, ctx: { userId: string; ip: string | null; userAgent: string | null }): Promise<void>` runs after commit. It invalidates the cache, writes one `SESSION_EVICTED` audit entry per evicted session, and creates the notification. This is the adapter's existing post-commit block, moved here.
- Callers: the adapter's `createSession` and the passkey route (C2).
- Invariants:
  - app-enforced: the Web-session cap has exactly one implementation. The schema cannot express the cap.
  - app-enforced: there are exactly two Web-session creators; the helper exists so they cannot drift (R48).
- Control class: fail-closed verification gate. The lock and count run in one transaction, and a missing tenant row throws. Adjudication authority: the `sessions` rows read under the lock.
- Forbidden patterns:
  - `pattern: tx\.session\.create\( — reason: only session-concurrency.ts may create Session rows` (outside that file).
  - `pattern: tx\.session\.deleteMany\(\{\s*where:\s*\{\s*userId:\s*user\.id\s*\},?\s*\}\) — reason: the passkey delete-all rotation is removed`. Must match the pre-change `route.ts` when checked with `grep -Pzo` (F-func-2).
- Acceptance:
  - Adapter tests pass unchanged apart from the import seam.
  - With cap N and N live sessions, a passkey sign-in evicts exactly the oldest session and writes `SESSION_EVICTED`.
  - With the cap null, nothing is evicted.
- Consumer walkthrough:
  - The adapter (`auth-adapter.ts` `createSession`) reads `{ session.userId, session.expires }` to build the `AdapterSession`. It reads `eviction` only to pass it to `reportSessionEviction`.
  - The passkey route reads `eviction` only to pass it to `reportSessionEviction`. It does not read `session`, because the cookie carries its own raw token and `expires` is computed by the route.

### C2 — Passkey sign-in: no cascade

- `src/app/api/auth/passkey/verify/route.ts`:
  - Remove the delete-all-sessions transaction and the `invalidateUserSessions(... allTenants ...)` call.
  - Create the session through C1 inside `withBypassRls(prisma, …, BYPASS_PURPOSE.AUTH_FLOW)`, with `provider: "webauthn"`, `passkeyVerifiedAt`, `authCredentialId`, and the tenant already resolved by `resolveOwningTenantIdFromClient`, which is the same adjudicator the adapter uses.
  - Then call `reportSessionEviction` after commit.
  - Keep `AUTH_LOGIN`. Remove the `SESSION_REVOKE_ALL { trigger: "passkey_signin" }` audit entry: nothing is revoked-all any more, and evictions are audited per session by C1.
- Remove `EXTENSION_TOKEN_REVOKE_REASON.PASSKEY_REAUTH`. Its only consumer is this route: `grep -rn "PASSKEY_REAUTH\b\|passkey_reauth\"" src messages`, where the remaining hits are the unrelated `AUTH_PASSKEY_REAUTH*` / `PASSKEY_REAUTH_*` names. Audit rows already written keep the free-form string; no label map reads it.
- `API_ERROR.SESSION_INVALIDATE_FAILED` stays, because change-passphrase and recovery-key/recover still use it.
- Invariant (R42, must not weaken): every secret-changing or membership-ending operation still calls `invalidateUserSessions` with all token models.
  - Member set from `grep -rn "invalidateUserSessions(" src --include='*.ts' | grep -v test`, after this change:
    - vault/change-passphrase
    - vault/rotate-key
    - vault/admin-reset
    - vault/reset
    - vault/recovery-key/recover
    - scim Users [id] ×3
    - teams members [memberId]
  - The passkey route is the only member removed. `user-session-invalidation.ts` and its model enumeration are not edited.
- Control class: this contract removes a side effect. It adds no control. The residual control for "revoke everything" is the explicit path list in Background.
- Forbidden patterns:
  - `pattern: invalidateUserSessions — reason: passkey verify must not cascade` (scoped to `src/app/api/auth/passkey/verify/route.ts`).
  - `pattern: PASSKEY_REAUTH: "passkey_reauth" — reason: dead reason constant removed`.
- Acceptance:
  - The unit test asserts that `invalidateUserSessions` is not called and that no delete-all runs.
  - The integration test shows a user holding an active extension family, an active iOS family and a second Web session. After passkey sign-in, all three are still active.

### C3 — Active client cap counts device families

- Constant: rename `EXTENSION_TOKEN_MAX_ACTIVE = 3` to `CLIENT_TOKEN_MAX_ACTIVE_FAMILIES = 3` in `src/lib/constants/auth/extension-token.ts`, and re-export it from `constants/index.ts`. The rename is deliberate: the unit changed, and an old import must fail to compile.
- Add reasons `SUPERSEDED_SAME_DEVICE: "superseded_same_device"` and `ACTIVE_FAMILY_CAP: "active_family_cap"` to `EXTENSION_TOKEN_REVOKE_REASON`.
- New helper in `src/lib/auth/tokens/extension-token.ts`:
  - `enforceActiveFamilyCap(tx: Prisma.TransactionClient, p: { userId: string; clientKind: "BROWSER_EXTENSION" | "IOS_APP"; cnfJkt: string; now: Date }): Promise<RevokedFamily[]>`, where `RevokedFamily = { familyId: string; reason: ExtensionTokenFamilyRevokeReason; rowsRevoked: number }`. Revocation is one `updateMany` per family, so `rowsRevoked` is per family. The post-commit audit metadata then matches `revokeExtensionTokenFamily`'s `{ reason, familyId, rowsRevoked }` (F-func-3).
  - Precondition: the caller has already taken `advisoryXactLock(tx, userId)` in the same transaction.
  - Step 1, supersede: find the active families with the same `userId`, `clientKind` and `cnfJkt` (non-null), then revoke each one's active rows. A family whose `updateMany().count` is 0 is not returned, mirroring `revokeExtensionTokenFamily`'s `count > 0` audit guard. A first-time connect therefore emits no audit entry (F-func-4).
  - Step 2, cap:
    - Membership comes from the active rows (`revokedAt: null`, `expiresAt > now`, `clientKind != IOS_AUTOFILL`), grouped by `familyId`.
    - Each member family's presence comes from `getFamilyPresenceAt(tx, familyId, familyCreatedAt)`, which is unfiltered over all of the family's rows. That matters because an iOS family's presence write can sit on its expired 24 h access row while the refresh row is still live (F-func-1).
    - Families are ordered by presence ascending, then `familyId` ascending as a total-order tie-break.
    - While `families + 1 > CLIENT_TOKEN_MAX_ACTIVE_FAMILIES`, revoke every active row of the first family.
  - Return the revoked families. The caller emits `EXTENSION_TOKEN_FAMILY_REVOKED` per family after commit, with the same payload as `revokeExtensionTokenFamily`. That function cannot run inside this transaction because it opens its own `withBypassRls`.
- Call sites. Member set from `grep -rn "extensionToken\.create(" src --include='*.ts' | grep -v test`:
  - `issueExtensionToken` (new family): replaces the row cap.
  - `issueIosToken`: replaces the row cap only when `familyId` is not supplied, i.e. a new family. When it is supplied (refresh rotation from `refreshIosToken`), neither supersede nor cap runs, so refresh never evicts.
  - `issueAutofillToken`: excluded from the count; does not call the helper. NEW in this branch (absent today): it takes `advisoryXactLock(tx, userId)` before its revoke-priors step, so the "one active AutoFill token" rule is serialized too (TOCTOU class; memory: project_count_then_create_toctou_class).
  - `/api/extension/token/refresh` rotation: unchanged, no cap, the family count stays constant.
- Invariants:
  - app-enforced, under the per-user advisory lock (proved by the probe): at most `CLIENT_TOKEN_MAX_ACTIVE_FAMILIES` active non-AutoFill families per user after any issuance. The schema cannot express a cross-row count cap.
  - Eviction never leaves a family half-revoked. Today's row cap can revoke only the iOS access row and leave its refresh row alive.
- Control class: fail-closed verification gate, a throttle against issuance abuse. It is not an authorization boundary. Adjudication authority: the `extension_tokens` rows read under the lock.
- Security note (R43): supersede only revokes. Issuance already requires proof of the DPoP key at exchange and an authenticated user, so a caller can only supersede their own install's family. The change widens nothing.
- Forbidden patterns:
  - `pattern: EXTENSION_TOKEN_MAX_ACTIVE — reason: renamed; row-count semantics removed`.
  - `pattern: active\.length \+ [12] - — reason: row-count cap removed`.
- Acceptance:
  - An extension family plus an iOS family plus an active AutoFill token, followed by a new connection from a different install, evicts nothing, because only 2 families count.
  - A 4th family evicts exactly the family with the oldest presence, all of its rows.
  - Reconnecting the same install (same `cnfJkt` and client kind) revokes only that install's previous family.
  - iOS refresh with 3 families active evicts nothing.
  - 10 concurrent issuances leave at most 3 active families. A lock-disabled variant of the same test fails.
- Consumer walkthrough: the returned `RevokedFamily[]` is read by the three issuers. Each passes `{ familyId, reason, rowsRevoked }` to the post-commit audit emit, together with `userId` and `tenantId` from its own params.

## Testing strategy

- Unit:
  - `src/app/api/auth/passkey/verify/route.test.ts`: replace the C7 assertions. Assert `invalidateUserSessions` is never called, the C1 helper receives the passkey fields, and `reportSessionEviction` runs only after the transaction resolves.
  - Adapter tests (`src/lib/auth/session/auth-adapter.test.ts`): the seam moves; behaviour assertions stay.
  - `src/lib/auth/tokens/extension-token.test.ts` and `mobile-token.test.ts`: rewrite the `+1` / `+2` row-maths cases to family semantics. Build boundary fixtures from `CLIENT_TOKEN_MAX_ACTIVE_FAMILIES`, not a literal 3 (F-test-5, RT3).
  - R19 mock alignment: the `EXTENSION_TOKEN_REVOKE_REASON` mock literals in `passkey/verify/route.test.ts`, `sessions/route.test.ts` and `extension/token/refresh/route.test.ts` drop `PASSKEY_REAUTH` and add the two new reasons (F-test-4).
- Integration, C3 (new `src/__tests__/db-integration/client-token-family-cap.integration.test.ts`, real DB):
  - The C3 acceptance cases.
  - The concurrency case asserts contention before the invariant (RT4, F-test-2), in this order:
    1. More than 3 distinct `family_id` values exist for the user, counting revoked rows too. Revocation only sets `revokedAt`, so the rows stay in the table.
    2. At least one `EXTENSION_TOKEN_FAMILY_REVOKED` row with `metadata.reason = "active_family_cap"` is in `audit_outbox.payload`, This file must NOT mock `@/lib/audit/audit`, unlike its siblings `client-token-presence` and `extension-token-dpop-flow`, which stub `logAuditAsync`. The real issuer → `logAuditAsync` → outbox path has to run. The reason is read with a superuser query on `audit_outbox` (F3-test-1). Not `audit_logs`: the workers are stopped under VE2, so nothing is drained into it (F2-test-2).
    3. At most 3 active families.
  - Presence-ordering regression (F2-test-3), pinning the F-func-1 fix:
    - Fixture: an iOS family whose access row has expired but whose refresh row is live and which has recent presence on the expired row, next to a family that is genuinely older.
    - Expected: the genuinely older family is evicted.
    - Tie-break case: two families with equal presence; the lower `familyId` is evicted.
  - AutoFill lock (F2-test-4): N concurrent `issueAutofillToken` calls leave exactly one active `IOS_AUTOFILL` row, and the lock-disabled variant fails.
  - Red proof: a throwaway variant (not committed) with `advisoryXactLock` mocked to a no-op, as in the Phase-1 probe, must fail for each concurrency case.
- Integration, C1 (new `src/__tests__/db-integration/session-concurrency-cap.integration.test.ts`, F-test-1):
  - Concurrent `createSessionUnderConcurrencyCap` calls for one user under a tenant with `maxConcurrentSessions = 2`.
  - Each call gets a test-chosen `sessionTokenDigest`. Eviction hard-deletes rows, so the lower bound is read from the digests themselves (F2-test-1):
    - All N calls resolved, and more than 2 of the known digests are now absent (they were evicted, which proves they were created and then contended).
    - Then at most 2 live sessions remain.
  - Ordering regression (F3-adj-1): seed 3 sessions with distinct `createdAt` whose random `id` order differs from their age order (choose the ids explicitly), then create one more under cap 3. Assert the earliest-`createdAt` session is the one evicted. This fails against the `id asc` code.
  - The same lock-disabled red proof applies.
- Integration, C2 (in the C1 file, or its own file):
  - A successful passkey sign-in against the real DB, with an active extension family, an active iOS family and a second Web session present beforehand. Assert all three survive.
  - Mock boundary: reuse the `vi.mock("@simplewebauthn/server", importOriginal …)` shape from `src/lib/auth/webauthn/verify-authentication-assertion.test.ts` (replace only `verifyAuthenticationResponse`).
  - Fixtures (F-test-3): a real `webauthn_credentials` row for the user in a bootstrap tenant, RP ID / origin env stubs, and challenge storage (in-memory when Redis is mocked to null, as the existing integration tests do).
  - Precedent note: `reauth-credential-binding.integration.test.ts` only covers deny paths, so this is the first successful-ceremony route test. If the fixture cost is prohibitive, record it in the deviation log with an Anti-Deferral entry rather than silently downgrading to a unit test.
- Each new assertion must fail when the change is reverted: run it once against `main`'s logic before relying on it.
- Full `npx vitest run`, `npx next build`, `npm run test:integration` (VE2), and `scripts/pre-pr.sh`.

## User operation scenarios

1. The user is signed in to the extension and the iPhone app, and signs in to the Web again with a passkey. Expected: both clients stay signed in, and no `EXTENSION_TOKEN_FAMILY_REVOKED` audit entry appears.
2. The user connects the extension, which requires a Web sign-in with a passkey. Expected: the iPhone app stays signed in.
3. The user signs out and back in on the iPhone app 3 times. Expected: the extension stays signed in, and each reconnect supersedes the previous iPhone family.
4. The user creates a passkey from the iOS AutoFill extension, which mints an AutoFill token, while the extension and iPhone are connected. Expected: nothing is evicted.
5. The user signs in on a 4th device. Expected: the device with the oldest presence is signed out, with an `active_family_cap` audit reason.
6. The user changes the passphrase. Expected: every client and token is revoked, as before.

Manual test (dev server :3001, extension, and iPhone via VE1): scenarios 1, 2, 3 and 6.

## Considerations & constraints

- The change loosens behaviour relative to C7, as the user decided. The explicit recovery paths are listed in Background.
- The row-cap semantics are observable only through eviction. No API returns the count.

### Scope contract

- **SC1** — ~~Passkey sign-in does not call `checkNewDeviceAndNotify`~~ Brought into scope in Phase 3 (code review F-sec-2, user decision 2026-09-29). Removing the cascade also removed the loud signal a misused passkey produced, so the new-device notification ships in the same change. See deviation D8.
- **SC2** — The E2E test for extension requests with a query string (deferred in the long-lived-client-login code review) goes to a separate branch.
- **SC3** — The `.gitleaks.toml` `^docs/` allowlist (memory: project_gitleaks_docs_allowlist_narrowing) goes to a separate branch.
- **SC4** — ~~`refreshIosToken` revokes the old rows in a separate transaction~~ Fixed in Phase 3 (code review F-func-2): the rotation revoke moved into `issueIosToken`'s locked transaction. See deviation D9.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Shared capped Web-session creation (adapter + passkey) | locked |
| C2 | Passkey sign-in without bearer/session cascade | locked |
| C3 | Active client cap by device family, AutoFill excluded, same-install supersede | locked |

## Implementation Checklist

Files to modify:
- C1:
  - NEW `src/lib/auth/session/session-concurrency.ts`
  - `src/lib/auth/session/auth-adapter.ts` (`createSession` delegates to the helper)
- C2:
  - `src/app/api/auth/passkey/verify/route.ts`
  - `src/lib/auth/tokens/extension-token.ts` (remove `PASSKEY_REAUTH`)
- C3:
  - `src/lib/constants/auth/extension-token.ts` and `src/lib/constants/index.ts` (rename)
  - `src/lib/auth/tokens/extension-token.ts` (reasons, `enforceActiveFamilyCap`, `issueExtensionToken`)
  - `src/lib/auth/tokens/mobile-token.ts` (`issueIosToken` new-family branch, `issueAutofillToken` lock)

Test trees, from `grep -rl` over `src` (co-located, `src/__tests__/`, integration) and `e2e`:
- `EXTENSION_TOKEN_MAX_ACTIVE`: `src/lib/auth/tokens/extension-token.test.ts`, `mobile-token.test.ts`
- `EXTENSION_TOKEN_REVOKE_REASON` mocks: `passkey/verify/route.test.ts`, `extension/token/refresh/route.test.ts`, `sessions/route.test.ts`
- `issueExtensionToken` / `issueIosToken` / `issueAutofillToken`:
  - `src/__tests__/api/extension/token-exchange-dpop.test.ts`
  - `extension/token/exchange/route.test.ts`
  - `mobile/token/route.test.ts`
  - `mobile/autofill-token/route.test.ts`
  - `db-integration/client-token-presence`
  - `db-integration/extension-token-dpop-flow`
  - `src/__tests__/integration/mobile-dpop-flow.integration.test.ts`
- `createSession`: `src/lib/auth/session/auth-adapter.test.ts`, `src/auth.test.ts`, `db-integration/session-create-cold-timeout-cache.integration.test.ts`
- `passkey_signin` / `invalidateUserSessions` (passkey): `passkey/verify/route.test.ts`
- No e2e reference to any of these.

Shared utilities to reuse (no reimplementation):
- `advisoryXactLock` (`src/lib/tenant-rls.ts`); `withBypassRls` / `BYPASS_PURPOSE` (same module); `withUserTenantRls` (`src/lib/tenant-context.ts`)
- `getFamilyPresenceAt` (`src/lib/auth/tokens/client-token-expiry.ts`)
- `logAuditAsync` / `personalAuditBase` (`src/lib/audit/audit.ts`); `invalidateCachedSessions` (`session-cache-helpers.ts`); `createNotification`
- `hashSessionToken`; `resolveOwningTenantIdFromClient`
- Integration helpers: `createTestContext` / `setBypassRlsGucs` (`src/__tests__/db-integration/helpers.ts`)

Static gates the diff joins:
- `check-count-then-create-lock` (`LOCK_RE` accepts `advisoryXactLock(`): the new `session-concurrency.ts` must call it.
- `check-session-token-hashed`: a `data.sessionToken` value must be named `*Digest`.
- `check-bypass-rls`: model allowlists for the passkey route (`user`, `session`, `tenant`) and `auth-adapter.ts`. Re-check after the passkey route stops touching `session` directly.
- `check-client-token-expiry`, `check-fail-closed-routes-have-test` (`fail-closed-manifest.txt` has a passkey/verify entry), `owning-tenant-adjudicator-manifest.json`.

CI parity: `scripts/pre-pr.sh` mirrors the app-ci job, and 15 CI gates were extracted. Run `scripts/pre-pr.sh` via `check-pre-pr.sh run` at Step 2-4.
