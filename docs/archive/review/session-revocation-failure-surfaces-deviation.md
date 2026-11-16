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

## D10: extension bridge code stamped with `User.tenantId` (found while verifying C9; fixed in code-review round 3, F3)
`src/app/api/extension/bridge-code/route.ts` stamped the code, its audit, its IP-restriction check and its passkey state with `User.tenantId` (the owning column), not the tenant of the active membership. Every other mint site (C9's evidence) uses the active membership. Round 2 left it unchanged on the grounds that it left no revocation gap.

Round 3 (F3) changed it. The route now resolves the tenant with `resolveUserTenantId`, the helper `withUserTenantRls` (and so `mobile/authorize`) uses, and stamps that one tenant on every step. A user with no active membership is refused with 401 and an `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` row with reason `no_active_membership`. That reason replaces `user_not_found`, which only the removed `users` read emitted. A lookup that throws (`MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED`) propagates and nothing is issued. The route no longer reads the column, so its entry left `scripts/checks/owning-tenant-adjudicator-manifest.json`.

Before the change, the column read ran under the membership tenant's RLS context, so a user whose column diverged from their membership got `user_not_found` instead of a code stamped with another tenant. The allow side is unchanged for a user whose column matches. The route test's per-user Redis-failure cell now also sees `checkRateLimitOrFail`'s own `RATE_LIMIT_FAIL_CLOSED` row. Before, the test's `@/lib/tenant-context` mock had no `resolveUserTenantId`, so that emit failed and was skipped.

## D11: TEAM_MEMBER_REMOVE commits with the removal (handoff from #1062)
#1062 moved the members POST, invitations POST and member PUT audits into their transactions and pinned them in `check-critical-audit-atomic`. Its session handed the member DELETE to this branch, because this branch rewrites that handler.

The DELETE now writes `TEAM_MEMBER_REMOVE` with `logAuditInTx` inside the removal's transaction, after the revocation, carrying `removedUserId`, `removedRole` and the revocation counts. The action is in `CRITICAL_ACTIONS` and in `IN_TX_ONLY_ACTIONS` (pinned at 1 emitter, async emits refused), and the gate self-test fixture lists it.

`cacheTombstoneFailures` is no longer in this row. It is known only after the commit, so it is reported by the tombstone helper's error log and Sentry signal (C5). A second audit row for it was not added: it would need a new audit action (R12 surface) to say what the helper's on-call signal already says.

The merge with origin/main (#1062) was resolved in `check-team-rotation-input-lock.mjs` and its self-test (rule 9 coexists with #1062's departureWriters / tenant-row-delete classes; no renumbering), in `check-bypass-rls.mjs` (both allowlist entries) and in the member route test.

## D12: session tenant binding and the rollout window (code-review round 3, F1/F8/F2/F9)
`getSessionAndUser` returns no session unless `Session.tenantId` is a tenant where the user holds a `tenant_members` row with `deactivated_at IS NULL`. It compares against the membership, never the `User.tenantId` column: realign and backfill move only the column, and `createSession` stamps the membership's tenant. The membership rows are read in the session read's own call, on a dedicated grant `AUTH_SESSION_LOOKUP` (`session`, `user`, `tenantMember`). `AUTH_SESSION_LIFECYCLE` dropped `user`, because only this call reached it (check-bypass-rls flags a stale grant model). Its new pair, (auth_flow, sessions), was the pair of a test-local grant in `bypass-refusal-helper` and `rls-bypass-grants` (integration-test-grants-no-collision refuses that, since it would credit the member with evidence). Those grants now list `session` and `account`; their cells still refuse a `users` read. check-bypass-rls's self-test cell that used `AUTH_SESSION_LIFECYCLE` as a session-and-user grant now uses `AUTH_DELETE_USER`, which has that pair.

Cost, measured by counting statements on the pg client: 5 statements before (BEGIN, GUCs, sessions, users, COMMIT), 6 after. The extra statement is an indexed `tenant_members` read by `user_id`, in the same transaction and on the same connection. Prisma issues relation selects as separate statements here (no `relationJoins`), so folding the read into the session read leaves the same round trip. Collapsing it to one statement would need raw SQL in the adapter.

A lookup that throws propagates out of `getSessionAndUser`, but not out of `auth()` (corrected in code-review round 4, S-R4-2). Auth.js's session action catches it, logs a `SessionTokenError` and answers 200 with a null body (`@auth/core/lib/actions/session.js`). A route handler's `auth()` therefore sees no session (401), and the proxy gate's `/api/auth/session` read sees no user and caches `valid: false` for `NEGATIVE_CACHE_TTL_MS` (5 s). Both fail closed. The adapter unit test "leaves Auth.js answering a session request with no session when the read throws" runs `@auth/core`'s `Auth` over the real adapter with the read throwing and pins the 200, the null body and the `SessionTokenError`. The proxy gate needs no change of its own: on a cache miss it reads `/api/auth/session`, which goes through the adapter, so a residue session is answered `valid: false` and cached only negatively. A positive entry written before this release, or by an old-release instance during the rollout, lasts at most `SESSION_CACHE_TTL_MS` (30 s). It only lets the request past the proxy; the route handler's own `auth()` goes through the binding.

F2: `createSession` resolves the tenant before it takes the credential lock, so a departure that commits in between can leave a session stamped with the tenant just left. Under the binding that session authenticates nowhere: its tenant has no active membership for the user. A return to that tenant goes through `returnToTenant`, which revokes it. `session-concurrency.ts` is unchanged.

Rollout window (F1/F8). The C9 migration commits before the old release's instances stop serving, and those can still leave residue: a SCIM or team departure whose post-commit revocation fails, or a directory-sync departure, which revoked nothing before this release. The migration header and plan C9 no longer say the residue "cannot grow back". That residue is made unusable elsewhere:
- Sessions: by the binding above.
- Reactivations of a deactivated row: `returnToTenant` revokes in the returning tenant (D8).
- Tokens: each is checked against the membership in its own tenant.

One path was left open in round 3. Code-review round 4 (S-R4-1) closed it: every creation of a membership row for an existing user now revokes in that tenant (D13). The round-3 analysis is kept below.

| Field | Content |
|-------|---------|
| Path | An old-release SCIM `DELETE /Users/<id>` whose post-commit revocation fails during the rollout. Then, before the credentials expire, the same user is created again in the same tenant: SCIM POST, a directory-sync create or a sign-in's row-4 upsert. SCIM DELETE deletes the membership row instead of deactivating it, so the re-creation is not a reactivation and `returnToTenant` does not run. The new active membership is in the credentials' own tenant, so the binding and the token checks accept them. |
| Worst case | Sessions and tokens the user held before the removal work again after the tenant re-admits them. If the removal was a response to a compromised credential, the stolen credential comes back with the re-admission. |
| Likelihood | Low. It needs all three: the DELETE lands on an old-release instance during the rollout (minutes), the revocation after its commit fails (a DB or lock fault, which was logged as `session-invalidation-failed`), and the same tenant re-creates that user before the credentials expire. |
| Cost to close | A revocation on every membership-creation path, scoped to the tenant: SCIM POST, directory-sync create and sign-in row 4. Each is a new writer in the C8 rule-9 class, with its own integration cell. Running the C9 block again after the rollout would also close it, but there is no operator command for that today. |
| Detection | The old release logs the failed revocation (`session-invalidation-failed`). |
| Status | Closed in code-review round 4 by the first option (D13). |

F9: the migration raises `departed-member-credential-residue-locks: users=<n>` before taking the locks. Its header and plan C9 state the bound: `max_locks_per_transaction × (max_connections + max_prepared_transactions)`. Round 4 (F-R4-1) corrected which of the two is the operator's signal; see D13. The migration is unreleased, so its checksum changed with the edit. On this worktree's database (`passwd_sso_wt_1047` only), its `_prisma_migrations` rows were deleted and `prisma migrate deploy` re-applied it. Two rows were present and deleted. The block is idempotent.

## D13: a membership creation revokes the residue an earlier membership left (code-review round 4)
S-R4-1. Every transaction that creates a `tenant_members` row for a user who already existed revokes that user's credentials in the row's tenant, as its last step, with `revokeUsersAuthArtifactsInTx(tx, [userId], { tenantFilter: { tenantId }, boundedLockWait: true })`. With no row in that tenant before, anything the user holds there is residue of an earlier membership, so nothing legitimate is revoked. This closes D12's open path (an old-release SCIM DELETE whose revocation failed, then a same-tenant re-creation).

Sites, from `grep` of `tenantMember.create/createMany/upsert` and raw `INSERT INTO tenant_members` over `src` and `scripts` (migrations and the `.sql` seed excluded):

| Site | Revokes | Notes |
|------|---------|-------|
| SCIM POST (`src/app/api/scim/v2/Users/route.ts`) | An existing user created active | After the mapping writes. A user created by the same request holds nothing; a row created deactivated already revokes through `departCreatedMembership`, so neither calls it again. The revocation reuses the route's `revocation` slot, so the post-commit tombstone (`scim_deprovision`) covers it. A lock held past the bounded wait is a 409 through `isMembershipLockConflict`, and nothing commits. Audit metadata is unchanged. |
| Directory-sync create (`src/lib/directory-sync/engine.ts`) | Existing users created active (`createdActive`) | One call after all transitions. Collected as `admissions` and tombstoned with the departures and returns after the commit. `directory-sync.credentials-revoked` gains `admittedUserIds` (capped at 100), `admittedUserCount`, and `userIdsTruncated` covers all three lists. A lock timeout fails the run into its ERROR path. |
| Sign-in row 4 (`src/auth.ts` `claimedTenantMembership`) | The signing-in user, in the joined tenant | After the upsert and the realignment. Tombstoned after the bypass transaction commits (`sign_in_membership_join`). The upsert is unconditional: the user is active in no tenant, so a deactivated row it finds (and leaves deactivated) holds only residue too. Auth.js calls `createSession` after the signIn callback returns, so the sign-in's own session is created after the revocation commits and is not touched; the integration cell creates it through the adapter and authenticates it. A lock held past the bounded wait throws, the signIn callback's catch refuses the sign-in as `provider_error` (fail closed), and the join rolls back. |
| Sign-in row 5 (`src/auth.ts`) | No | The user is already an active member of that tenant, so the upsert creates nothing; revoking would end a member's own credentials. Exempted in the gate. |
| Adapter `createUser` (`src/lib/auth/session/auth-adapter.ts`) | No | A brand-new user created in the same transaction holds nothing. Exempted. |
| Bootstrap migration (`src/auth.ts`) | No | Moves the user's sessions into the target first, so a revocation would delete them (as rule 9's exemption). Exempted. |

Lock order: the user-auth lock is the last lock in each transaction, as C1 requires.

Gate. C8 gains rule 10 in `check-team-rotation-input-lock.mjs`: each creation (`tenantMember.create/createMany/createManyAndReturn/upsert`, any receiver, or a raw `INSERT INTO` / `MERGE … THEN INSERT` into `tenant_members`) needs a revoker after it in its innermost function. The revokers are rule 9's two plus `departCreatedMembership`. Otherwise it needs a reviewed exemption. The six real sites are pinned by key in `EXPECTED_MEMBERSHIP_CREATIONS` (3 revoking, 3 exempted). Rows 4 and 5 share an anonymous callback, so a repeated key carries its `create` payload's text, as grants do. The self-test passes synthetic creation keys through `TEAM_ROTATION_INPUT_LOCK_EXTRA_CREATIONS`, as it passes the counts. Two existing rule-2 cells that only checked `code === 1` now assert their own `tenant-state` reason. One departure-writer cell adds the revocation its upsert now needs.

S-R4-2 and F-R4-1 are recorded in D12 and plan C9. The migration header and plan C9 now name the operator signal as the failure itself: PostgreSQL's `out of shared memory` with the HINT to raise `max_locks_per_transaction`. The NOTICE is only a supporting diagnostic. Evidence that `prisma migrate deploy` does not print server NOTICEs: on `passwd_sso_wt_1047`, the migration's `_prisma_migrations` row was deleted (one row each time, twice) and `npx prisma migrate deploy` re-applied it (exit 0). Its output has no NOTICE line, although the block raises two unconditionally. The edit changed the unreleased migration's checksum, and the re-apply recorded the new one.

F-R4-2, not changing: deleting session rows the binding refuses. With D13, a residue session in a tenant whose membership is re-created is revoked by that creation. A residue session in a tenant the user is not active in stays dead under the binding (D12). So a refused row has no path back to authenticating, and deleting it on read would add a write to the session read path for no security gain.

T-4: the round-3 F3 stamping cell is re-proved with mutations that keep the route runnable (round-4 table below). The round-3 row, which used the pre-change route (`HEAD`), is replaced there.

## Red-proof record (code-review round 3)
Same method: scratch copies outside the repository, aliased in through a scratch vitest config (unit and integration), or read through `RESIDUE_MIGRATION_SQL`. Each unmutated control passed through the same config.

| Cell | Mutation | Observed failure |
|------|----------|------------------|
| F1 adapter unit, deny | Binding check removed (`if (false)`) | Only the two "returns no session" cells fail |
| F1 adapter unit, allow | Always refuse (`if (true)`) | Only "returns the session when its tenant is the user's active membership" fails |
| F1 integration, deny | Binding check removed | "refuses a session under a tenant the user left …" and "refuses a session of a user active in no tenant" fail (`expected { session … } to be null`) |
| F1 integration, allow (divergent column) | Compare `Session.tenantId` with `User.tenantId` instead of the membership | The two deny cells fail, and so does "authenticates a session of the active membership when the User.tenantId column names another tenant" (`expected null to match object`) |
| F1 integration, allow (normal) | Always refuse | The normal, the positive-control and the divergent-column cells fail |
| F1 bootstrap migration (tenant-claim-binding, row 6) | `src/auth.ts` without the migration's `session.updateMany` | Both modes fail at the new post-migration `getSessionAndUser` assertion (`expected null to match object`) |
| F3 bridge code, no membership | The `!tenantId` refusal removed | Only the `no_active_membership` cell fails |
| F3 bridge code, stamping | Superseded in round 4 (T-4). The pre-change route (`HEAD`) changed the tenant read and every stamp at once, and 20 of 27 cells failed, so the row did not show that the stamping cell fails on a wrong stamp alone. See the round-4 table. |
| Q-1 lock held | The block's `PERFORM pg_advisory_xact_lock` replaced by `PERFORM hashtext(k)` | The lock cell fails (`departed: true, rowless: true`), and so does the expiry cell's `rowless` control |
| Q-1 expiry filter | The `expires > v_now` / `expires_at > v_now` filters dropped from the lock set | Only the expiry cell fails (`expiredOnly: false`) |
| Q-3 operator token subject | Operator tokens matched on `created_by_user_id` | The main cell fails (subject token `live`, creator token `revoked`), and so does the idempotency cell (`users: 1`) |
| Q-6 report lower bounds | Report NOTICE prints `0` for sessions | Only the main cell fails: `sessions: expected 0 to be greater than or equal to 2` |
| F9 lock NOTICE | The `-locks` NOTICE removed | All four cells fail in `runBlock` (`expected [] to have a length of 1`) |
| Q-2 member DELETE audit | The `TEAM_MEMBER_REMOVE` `logAuditInTx` wrapped in `.catch(() => {})` | Only the new "propagates a failing in-transaction TEAM_MEMBER_REMOVE audit" cell fails |
| Q-4 positive control | The `TEAM_MEMBER_REMOVE` write skipped | The guest-actor allow loop fails, and so do the audit cell and the Q-2 cell |

## Red-proof record (code-review round 4)
Same method. Unit and integration mutants are scratch copies aliased in through a scratch vitest config, one module at a time. The gate mutants are scratch copies of the gate, each run by the unchanged self-test from its own scratch directory. Each unmutated control passed through the same config: auth 94/94, SCIM route 35/35, engine 57/57, bridge code 27/27, the two integration blocks 2/2 each, gate self-test 302/302.

| Cell | Mutation | Observed failure |
|------|----------|------------------|
| S-R4-1 sign-in, unit | Row 4 revokes `[]` | Only "row 4: revokes what the user still holds in the joined tenant, last, with a bounded wait" fails |
| S-R4-1 sign-in, unit (scope) | Row 4 revokes with `tenantFilter: {}` | Only the same cell fails |
| S-R4-1 sign-in, unit (order) | The revocation moved before the upsert | Only the same cell fails (order assertion) |
| S-R4-1 sign-in, unit (after commit) | The tombstone moved into the bypass transaction | Only "row 4: tombstones the revoked sessions after the join's transaction commits" fails |
| S-R4-1 sign-in, integration | Row 4 revokes `[]` | Both modes fail: `expected { session: true, apiKey: true, … } to deeply equal { session: false, apiKey: false, … }` |
| S-R4-1 sign-in, integration (scope) | Row 4 revokes with `tenantFilter: {}` | Both modes fail on the home tenant's control: `expected { session: false, … } to deeply equal { session: true, … }` |
| S-R4-1 sign-in, integration (order) | The revocation moved before the upsert | Stays green, as expected: the order only matters for lock order, and the unit order cell holds it |
| S-R4-1 SCIM POST, unit | The creation's revocation removed (`if (false)`) | The "revokes an existing user's residue …" cell and the 409 lock-timeout cell fail |
| S-R4-1 SCIM POST, unit (scope / order) | `tenantFilter: {}`; separately, the revocation moved before the mapping writes | Only the "revokes an existing user's residue …" cell fails in each |
| S-R4-1 SCIM POST, integration | The creation's revocation removed | Only the SCIM POST cell fails: `expected { session: true, … } to deeply equal { session: false, … }` |
| S-R4-1 SCIM POST, integration (scope) | `tenantFilter: {}` | Stays green. The route runs in the tenant's RLS context, where another tenant's rows are invisible, so the scope also holds without the filter. The other-tenant control does red the sign-in mutant, which runs under a bypass |
| S-R4-1 directory sync, unit | The admission revokes `[]` | Only the "revokes an attached existing user's residue …" cell fails |
| S-R4-1 directory sync, unit (users created by the run) | `createdActive` also takes users the run created | Only "revokes nothing for a user the run created or a member it created deactivated" fails |
| S-R4-1 directory sync, unit (order) | The admission's revocation moved before the departures | Only the "revokes an attached existing user's residue …" cell fails (`expected 1940 to be less than 1939`) |
| S-R4-1 directory sync, integration | The admission revokes `[]` | Only the directory-sync cell fails, on the residue state |
| C8 rule 10 (gate) | The rule-10 violation not raised | 11 cells fail: the 6 REDS, the before/nested cells, and the row-4, SCIM POST and directory-sync removal cells |
| C8 rule 10 (gate) | Raw templates not read | Only the raw INSERT and MERGE … THEN INSERT cells fail |
| C8 rule 10 (gate) | `departCreatedMembership` not a revoker | 4 cells fail: the two accepting rule-2 cells, the SCIM-POST shape cell, and the departCreatedMembership cell. The rule-2 "without the creation lock" cell also fails, on its `not.toMatch(/membership-create/)` |
| C8 rule 10 (gate) | Repeated keys not disambiguated | 97 cells fail: the real row-4/5 keys collide, so every run reports the pinned set as differing |
| C8 rule 10 (gate) | The pinned-set comparison skipped | The unexpected-site, missing-site and repeated-key cells fail |
| C8 rule 10 (gate) | A revoker anywhere in the file counts | The before-the-write, nested-callback and directory-sync-in-callback cells fail |
| T-4 bridge code, stamping (replaces the round-3 row) | `extensionBridgeCode.create` stamped `tenantId: "tenant-other"`; the route still runs and answers 201 | "stamps the code … with the active membership's tenant" and "issues a bridge code on success and emits ONLY the success audit" fail. Both check the create's `data.tenantId` (`+ "tenantId": "tenant-other"`) |
| T-4 bridge code, IP restriction | `checkAccessRestrictionWithAudit` given `"tenant-other"`; the route still runs | Only the stamping cell fails, on the restriction call's arguments. The `tenant_access_restricted` cell stays green because its mock denies whatever tenant it is given |
