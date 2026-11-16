# Coding Deviation Log: session-revocation-failure-surfaces

## D1: C5 signal deltas (recorded per the C5 adopter table)
- `invalidateUserSessions`, `src/auth.ts`: log fields, message and Sentry payload are byte-identical, pinned by `user-session-invalidation.test.ts` and `auth.test.ts`. One behavioural change: a throw from `invalidateCachedSessions` used to propagate and is now caught, counting every token as failed. That function does not throw in practice; the helper must never throw because it runs after a commit.
- `member-passkey-revoke.ts`: on a partial failure it gains the `session.cache_tombstone_failures` error log. A Redis throw is now logged as `session.cache_tombstone_failures` with `error` fields, not as `tenant.member_passkey_revoke_cache_invalidation_failed`.
- SCIM `Users/[id]` and POST, and team DELETE: Sentry text and tag changed from `…during invalidateUserSessions` / `unspecified` to `…during SCIM user deprovisioning` / `scim_deprovision` and `…during team member removal` / `team_member_remove`. The `_logType` and level are unchanged.
- Directory sync: a new signal, `directory_sync_deprovision`, with `extra { tenantId, configId }`.

## D2: single-user lock statement
`revokeUserAuthArtifactsInTx(tx, id)` now takes its lock through the batch `unnest` statement of `lockUsersAuthArtifacts` instead of `advisoryXactLock`. It uses the same key (`userAuthLockKey`) and the same `hashtext`, so it serializes against mints exactly as before. T6's lock-identity cell pins this.

## D3: admin-reset `SESSION_REVOKE_ALL` metadata
The metadata spreads the whole `invalidateUserSessions` result, so `cacheTombstoneFailures` appears in the row next to the counts and `revokedCount`.

## D4: directory-sync `credentials-revoked` log
Emitted at info level, and only when a count is above zero. A run that revokes nothing logs nothing.

## D5: SCIM PUT, the externalId mapping after the revocation
In `replaceScimUser`, the `scimExternalMapping` writes run after `departFromTenant` returns, so the user-auth lock is not literally the last lock of a PUT transaction. Mints never touch `scim_external_mappings`, and nothing holding user-auth waits on that table, so no cycle forms. The order is left as the existing code had it, rather than moving the mapping writes ahead of the departure.

## D6: bearer-passkey gate manifest
`scripts/checks/bearer-passkey-gate-manifest.json`: the `opaque-where` entry moved from `revokeUserAuthArtifactsInTx` to `revokeUsersAuthArtifactsInTx`, because the eight token-model queries now live in the batch primitive. The class and the call count (8) are unchanged. The file was not in the Implementation Checklist; the gate's real-repo test found it.

## D7: comment-only updates in four token tests
`extension-token.test.ts`, `api-key.test.ts`, `tenant-context.test.ts` and `mcp/oauth-server.test.ts` carried "L2" comments describing the old fail-open SCIM path (logged and answered 200). The comments now describe the atomic revocation. Test names and assertions are unchanged.

## Red-proof record (Phase 2)
Every mutation ran on a scratch copy, outside the repository, through a scratch vitest alias config. Production files were never mutated, and each unmutated control passed through the same config.

| Cell | Mutation | Observed failure |
|------|----------|------------------|
| T1 (SCIM PATCH/PUT/DELETE, team DELETE) | All 11 changed modules aliased to their `HEAD~` (pre-change) source | 4/4 fail: `promise resolved "Response { status: 200 … }" instead of rejecting` (200/200/204/200). The log shows `session-invalidation-failed`: the fault fired after the commit and was swallowed. T2, T7 and T8 also fail on pre-change source (5/5). |
| T6 lock identity | Key prefix in `lockUsersAuthArtifacts` changed to `user-auth-mutated:` | `expected 'settled' to be 'parked'`. The bounded-wait cells also fail (`expected 200 to be 409`). |
| T6 lock order | `lockUsersAuthArtifacts` called before `endTeamMemberships` in `departFromTenant` | `syncError: "… Code: 40P01 … deadlock detected"` instead of both commit |
| T6 fresh budget (unit) | Transition budget passed to the revocation lock | Only the fresh-budget cell fails, with `UserAuthLockTimeoutError` |
| Revocation last (unit) | Revoke before `endTeamMemberships` | Only the "revokes, last" cell fails |
| C8 rule 9 (gate self-test) | 22 single-clause mutations of the gate (m01–m22: each subject arm, the fail-closed cases, source order, innermost function, before-skip placement, missing/unexpected checks, the exemption) | Each reddens its own cells; listed per mutation in the C8 implementer's report |

T1's "unseeded faulted table" red was not run as a separate mutation. `expectSeeded` (row counts before the snapshot) and the touch of the code row while the fault is armed, which proves the trigger passes while the session exists, cover the same failure.
