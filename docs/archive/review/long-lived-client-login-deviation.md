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

## B3 (extension)

- D-B3-1 `swFetch` gained a 401 → single-flight refresh → retry-once path (the plan's single-flight bullet named a "401 retry" caller that did not exist yet). `/api/vault/unlock/verify` bypasses it so its 401 is observed as-is.
- D-B3-2 Activity from extension pages counts for C6 except `KEEPALIVE_PING` (offscreen keepalive every 25 s would otherwise make auto-lock unreachable). Orchestrator checked the popup's storage-change status refresh: it runs only while the popup is open, so it cannot keep an unattended vault unlocked.
- D-B3-3 Content scripts set `userGesture: true` at the three `onSelect` send sites; each is reachable only from `suggestion-dropdown.ts`'s `isTrusted`-gated handlers.
- D-B3-4 Six new `BackgroundWarnEvent` members in `background/log.ts` (one per verify outcome, plus an unexpected-status fallback).
- D-B3-5 Golden vector: extension uses secretKey `00…1f` (same as iOS); the existing web test pins a different vector (`0xaa`×32). Converged in B2 via the frozen JSON.

## B2 / B5 and static-gate fixes

- D-B2-1 The web parity test keeps its existing `0xaa`×32 vector and adds the frozen `00…1f` vector (Check F keys on the frozen one). CLI (`cli/src/__tests__/unit/crypto.test.ts`) and e2e (`e2e/helpers/crypto.test.ts`) keep their own unrelated vectors — outside the web/extension/iOS parity set C1 names.
- D-B2-2 `check-client-token-expiry.mjs` needed no CI yaml edit: the static-checks job runs `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`, so the pre-pr queue entry is the CI wiring. No `package.json` script (sibling has none). Exemptions file is header-only (all three expiry writers import the helper).
- D-B5-1 Docs also updated beyond the C12 list where they stated now-false facts: `docs/security/auth-surface-matrix.md` (iOS TTL source), `docs/api/error-handling.md` (422 sites + monitoring note), `docs/security/threat-model.md` (I3 and offline brute-force residual), `docs/security/considerations/ja.md` (mirror).
- D-FIX-1 Four static gates were red after B1a/B1b and were fixed by the orchestrator: `check-bypass-rls.mjs` allowlist (+`tenant`/`extensionToken` for refresh route, mobile-token, mobile token route; new entry for unlock/verify — all keyed by ids from validated token rows); `check-null-tenant-fail-closed.mjs` manifest (`mobile-token.ts`, `mobile/token/route.ts` → `throw`, both throw on a missing tenant row); migration wrapped in `BEGIN; … COMMIT;` for `check-migration-transaction.mjs`, with the dev DB's `_prisma_migrations.checksum` row for this branch's own migration updated to the new file hash (a `--create-only` probe then produced only Prisma's recurring `prev_hash` no-op, i.e. no drift); `route-policy-matrix.md` regenerated.

## Phase 2 completion (Step 2-4 / 2-5)

- Full pre-PR (`check-pre-pr.sh run`): 92 steps pass. Integration (workers stopped): 115 files / 724 tests pass. CI-only gates run manually: `check-state-mutation-centralization.sh`, `licenses:check:strict`, `licenses:check:ext:strict` pass. iOS on z1mn-island: xcodebuild test exit 0.
- Citation gate: plan and deviation log contain zero `path:line` citations; `verify-references.sh --strict` exits 1 on empty input because its REFS `grep` fails under `set -euo pipefail` before the empty-set branch — a hook defect, reported to the user, not a citation issue.
- Mechanical pre-checks: all hits triaged as false positives (fixture ids coinciding with other tests' constants; `typeof raw.token` and a script array index flagged as non-timing-safe compares; `verify-auth-hash.test.ts` flagged as an orphaned "check" by name).
- Self-R-check (three sub-agents): No findings from functionality, security, or testing.
