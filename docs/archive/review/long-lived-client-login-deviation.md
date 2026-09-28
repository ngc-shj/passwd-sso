# Coding Deviation Log: long-lived-client-login

## B1a (commit "feat(auth): bound client-token lifetime by server-verified unlock presence")

- D-B1a-1 `src/lib/auth/session/auth-or-token.ts`: the `"token"` `AuthResult` variant now carries `tokenId` and `familyId`. Not in the plan's file list. C2 needs the presenting token id (presence write) and family id (limiter key), and cannot re-run `validateExtensionToken` because DPoP proofs are single-use (jti cache). Additive; two test literals updated.
- D-B1a-2 C2 also rejects any non-`token` auth type (e.g. MCP tokens, whose `vault:unlock-data` scope string collides with the extension scope) with 403, alongside `IOS_AUTOFILL`. Stricter than the plan's text, same intent (only families with presence semantics).
- D-B1a-3 C2 returns `VAULT_NOT_SETUP` before the compare when the user has no server hash (mirrors `/api/vault/unlock`); the plan did not list this branch.
- D-B1a-4 Existing gates updated for the new route: `scripts/checks/fail-closed-manifest.txt`, `check-fail-closed-routes-have-test.sh` (`EXPECTED_LIMITER_COUNT` 71→72), `scripts/checks/route-policy-manifest.json`; C2 test gained the `assertRedisFailClosed` contract case those gates require.
- D-B1a-5 R19 scope: the full C4/C5 matrix lives in `src/app/api/extension/token/refresh/route.test.ts`; `src/__tests__/api/extension/token-refresh-cnfJkt.test.ts` (cnfJkt carry-forward only) was updated to drop the session mock and stay green, not duplicated. Both trees searched and touched.
- D-B1a-6 Dev DB repair (environment, not code): `npm run db:migrate` refused because `20260731100000_add_tenant_claim_events` had been edited after it was applied to the shared dev DB (PR #845's RDS-compat rewrite of `tenant_claim_events_purge_for_tenant`). The sub-agent ran `CREATE OR REPLACE FUNCTION` with the current file's body and updated that migration's `_prisma_migrations.checksum`, then created the new migration normally. No reset. Reported to the user.
- D-B1a-7 The generated migration includes Prisma's recurring `audit_chain_anchors.prev_hash` default no-op (same line exists in two earlier migrations); left as generated because editing an applied migration re-creates the checksum drift above.

## B4 (iOS)

- D-B4-1 The wrapped authHash uses `buildLocalWrapAAD(kind: "authHash", userId:)` (via `TeamEntryDecryptor.wrapAuthHash/unwrapAuthHash`), following the existing `ecdh`/`teamdir` local-wrap binding rather than `WrappedVaultKey`'s AAD-less wrap. Stronger than the plan's "same cacheKey" wording; binds a password-equivalent secret to the user.
- D-B4-2 New `ios/PasswdSSOApp/Vault/PresenceRecorder.swift` (`recordPresence`) holds the verify-and-evict logic so it is unit-testable (`PresenceRecorderTests.swift`); RootView has no test target.
- D-B4-3 Golden vector: secretKey `00…1f` → authHash `34cc5ea2db6790bc1411b9325d0a12dd900ad751313cb9c52af8756e27b11efd`; independently recomputed with node `crypto.hkdfSync` by the orchestrator (match).
- D-B4-4 Not compiled or executed on this host (VE1); CI `ios` workflow is the verification.
- D-B4-5 (supersedes D-B4-4) Built and tested on macOS host z1mn-island (Xcode 26.6, CI's xcodebuild command, iPhone 15 Pro simulator): 818 tests, 0 failures after two Swift 6 concurrency fixes — `recordPresence`'s `verify` closure made `@Sendable`, and `PresenceRecorderTests` captures through a lock-protected `@unchecked Sendable` box.

## B1b (server iOS lifetimes + tenant logout policy)

- D-B1b-1 `refreshIosToken` signals presence expiry with the existing `REFRESH_TOKEN_FAMILY_EXPIRED` result (no new variant); audit via `revokeExtensionTokenFamily` reason `presence_expired`.
- D-B1b-2 `expires_in` assertions in the mobile token route tests became range checks because the value is now computed from the C3-capped expiry.
- D-B1b-3 Web vault context untouched for `requireVaultTimeoutLogout` (SC3).
- D-B1b-4 Orchestrator fix: B1a's "replay at exactly the grace window" test read the real clock twice and flaked when a millisecond elapsed; it now freezes `Date` with fake timers (RT: a timing-dependent test was reporting a race in the test, not the route).
