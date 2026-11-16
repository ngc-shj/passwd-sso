# Coding Deviation Log: session-revocation-failure-surfaces

## D1: C5 signal deltas (recorded per the C5 adopter table)
- `invalidateUserSessions`, `src/auth.ts`: log fields, message and Sentry payload are byte-identical, pinned by `user-session-invalidation.test.ts` and `auth.test.ts`. One behavioural change: a throw from `invalidateCachedSessions` used to propagate and is now caught, counting every token as failed. That function does not throw in practice; the helper must never throw because it runs after a commit.
- `member-passkey-revoke.ts`: on a partial failure it gains the `session.cache_tombstone_failures` error log. A Redis throw is now logged as `session.cache_tombstone_failures` with `error` fields, not as `tenant.member_passkey_revoke_cache_invalidation_failed`.
- SCIM `Users/[id]` and POST, and team DELETE: Sentry text and tag changed from `…during invalidateUserSessions` / `unspecified` to `…during SCIM user deprovisioning` / `scim_deprovision` and `…during team member removal` / `team_member_remove`. The `_logType` and level are unchanged.
- Directory sync: a new signal, `directory_sync_deprovision`, with `extra { tenantId, configId }`.
- Code-review round-1 F2: the error log now also carries `context.extra`, spread first so it cannot replace `failures`, `reason` or `_logType`. The message and Sentry payload are unchanged. The log fields of `invalidateUserSessions` and `src/auth.ts` therefore gain `tenantScope`, and the passkey-revoke and directory-sync lines gain their subject ids (`targetUserId`; `tenantId`, `configId`), so they are no longer byte-identical to the pre-change fields.

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

## D8: `returnToTenant` revokes (code-review round-1 S1)
Not in the plan's C2 as first written, which revoked only on membership ends. A return now revokes, scoped `{ tenantId }` with `boundedLockWait: true`, for exactly the transitioned ids, as its last step after the team-membership restore, and returns `{ userIds, revocation }` like `departFromTenant`. Departures made before this change (every directory-sync one, swallowed SCIM/team failures) left credentials alive in the tenant, and a reactivation would otherwise revive them. Consequences:
- `replaceScimUser` / `patchScimUser` return a non-null `revocation` for `SCIM_USER_REACTIVATE` too. The SCIM `[id]` route already tombstones and records the counts whenever `revocation !== null`, so the `SCIM_USER_REACTIVATE` audit row now carries them, and the tombstone signal is the existing `scim_deprovision` one.
- Directory sync collects the return's revocation with the departures', tombstones it after the commit and sums it into `directory-sync.credentials-revoked`. That line now also names the users (`departedUserIds`, `returnedUserIds`; round-1 S2), since a departed user with no team membership has no `TEAM_MEMBER_TENANT_DEACTIVATE` row.
- A return can now be refused with 409 (`UserAuthLockTimeoutError`) when the user's credential lock is held past the bounded wait, as a departure can.
- Lock order is unchanged: the credential lock is the last lock of the return, after the team locks and the restore writes.

## D9: one-time revocation of pre-change residue (code-review round-2 F5/S3; plan C9)
D8 revokes the residue only when the user returns to the same tenant. Any other admission also revives it: a SCIM POST or directory-sync create of the existing user, an SSO sign-in's membership upsert, or an active membership in another tenant, because the proxy session gate checks "active anywhere". Migration `20261116200000_revoke_departed_member_credential_residue` therefore revokes it once, for every tenant. Details are in plan C9. Other code-review round-2 changes:
- F6: the tombstone helper's Sentry `extra` now has the same precedence as its error log, `{ ...context.extra, ...userField, failures }`, so `extra` cannot replace `userId` or `failures` there either.
- F7/S4: `directory-sync.credentials-revoked` caps `departedUserIds` and `returnedUserIds` at 100 each. It adds `departedUserCount`, `returnedUserCount` and `userIdsTruncated`.
- T-1: the SCIM `Users/[id]` route test now places its commit marker on the route's `withTenantRls` double, the outermost transaction. The service's `$transaction` double no longer marks a commit, because in production that transaction joins the route's context.

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

## Red-proof record (code-review round 1)
Same method as Phase 2: scratch copies outside the repository, aliased in through a scratch vitest config; each unmutated control passed through the same config.

| Cell | Mutation | Observed failure |
|------|----------|------------------|
| T-1 team member DELETE "tombstones … after the commit" | Tombstone moved inside the `withTeamTenantRls` callback | Only that cell fails: `expected 1336 to be less than 1335` (commit after tombstone) |
| T-1 SCIM `[id]` PUT/PATCH deactivation, PUT/PATCH reactivation, DELETE | `scim-user-service.ts` tombstones inside each transaction callback (the route's post-commit call gets no tokens) | Exactly those 5 cells fail, each on the commit-order assertion |
| T-1 SCIM POST created-deactivated | Tombstone moved inside the `withTenantRls` callback | Only that cell fails, on the commit-order assertion |
| T-1 directory sync (departures; reactivation) | `reportRevocations` moved inside the apply transaction | Exactly those 2 cells fail, on the commit-order assertion |
| S1 unit "revokes the returned users' credentials … last" | `returnToTenant` revokes `[]`; separately, revokes before the team-membership restore | Only that cell fails in each (`expected -1 to be greater than 6`; `expected 3 to be greater than 10`) |
| S1 integration (SCIM PATCH active=true; directory-sync reactivation) | `returnToTenant` revokes `[]` | Both cells fail: `expected { session: true, … } to deeply equal { session: false, … }` |

## Red-proof record (code-review round 2)
Same method. The migration mutants were scratch copies of `migration.sql`, read through `RESIDUE_MIGRATION_SQL` (the test's `redProofOverride`). The unit mutants were scratch copies aliased in through a scratch vitest config.

| Cell | Mutation | Observed failure |
|------|----------|------------------|
| C9 residue/controls | `DELETE FROM sessions` without its `NOT EXISTS` | The main cell fails: `memberInA.sessions` and `departedInB.sessions` read `revoked` |
| C9 per model | The `mobile_bridge_codes` statement dropped | `departedInA` and `rowlessInA` `mobile_bridge_codes` stay `live`. The idempotency cell fails too (`users: 2`) |
| C9 userless rows | `user_id IS NOT NULL` dropped from `mcp_access_tokens` | `userlessInA.mcp_access_tokens` reads `revoked` |
| C9 active-only | `deactivated_at IS NULL` dropped from the `extension_tokens` predicate | `departedInA.extension_tokens` stays `live` (a deactivated row counted as membership) |
| C9 idempotency | `revoked_at IS NULL` dropped from `api_keys` | The second run reports `api_keys: 2` |
| F6 Sentry precedence | Sentry `extra` back to `{ ...userField, failures, ...context.extra }` | Only "logs the context's extra fields without letting them replace the signal's own" fails |
| F7 departed cap | `departedUserIds` not sliced | Only the 101-departed cell fails |
| F7 returned cap | `returnedUserIds` not sliced | Only the 101-returned cell fails |
| F7 boundary | `>=` instead of `>` in `userIdsTruncated` | Only the exactly-100 cell fails |
| F7 counts | `returnedUserCount` omitted | The summed-counts cell and the three cap cells fail |
| T-1 SCIM PUT / PATCH / DELETE | `scim-user-service.ts` tombstones after its `$transaction`, still inside the route's context | Exactly the 2 PUT, 2 PATCH and 1 DELETE tombstone cells fail on `expectTombstoneAfterCommitFollowing` (e.g. `expected 302 to be less than 299`) |

## D10: extension bridge code stamped with `User.tenantId` (found while verifying C9; not changed)
`src/app/api/extension/bridge-code/route.ts` stamps the code, its audit, its policy and its passkey state with `User.tenantId` (the owning column), not the tenant of the active membership. Every other mint site (C9's evidence) uses the active membership.

This leaves no revocation gap:
- A code stamped under a stale tenant can only be exchanged inside the active tenant's context (`withUserTenantRls`).
- C13 then refuses any extension token outside the user's active tenant.
- The C9 migration's consumption of such a code therefore removes nothing usable.

Aligning the whole route to the active membership belongs to the owning-column work (`resolveOwningTenantIdFromClient` adoption, `tenant-domain measure/backfill-owning-column`). It changes that route's policy and audit tenant and is not a revocation change. No edit is made in this PR.

## D11: TEAM_MEMBER_REMOVE commits with the removal (handoff from #1062)
#1062 moved the members POST, invitations POST and member PUT audits into their transactions and pinned them in `check-critical-audit-atomic`. Its session handed the member DELETE to this branch, because this branch rewrites that handler.

The DELETE now writes `TEAM_MEMBER_REMOVE` with `logAuditInTx` inside the removal's transaction, after the revocation, carrying `removedUserId`, `removedRole` and the revocation counts. The action is in `CRITICAL_ACTIONS` and in `IN_TX_ONLY_ACTIONS` (pinned at 1 emitter, async emits refused), and the gate self-test fixture lists it.

`cacheTombstoneFailures` is no longer in this row. It is known only after the commit, so it is reported by the tombstone helper's error log and Sentry signal (C5). A second audit row for it was not added: it would need a new audit action (R12 surface) to say what the helper's on-call signal already says.

The merge with origin/main (#1062) was resolved in `check-team-rotation-input-lock.mjs` and its self-test (rule 9 coexists with #1062's departureWriters / tenant-row-delete classes; no renumbering), in `check-bypass-rls.mjs` (both allowlist entries) and in the member route test.
