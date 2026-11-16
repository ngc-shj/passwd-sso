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
