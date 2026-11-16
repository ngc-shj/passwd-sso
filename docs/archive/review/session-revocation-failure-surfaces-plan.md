# Plan: session-revocation-failure-surfaces (`#1047`)

## Project context

- Type: web app (Next.js App Router + Prisma 7 + PostgreSQL 16, RLS enforced on `passwd_app`)
- Test infrastructure: unit + integration (real-DB, `npm run test:integration`) + E2E + CI/CD
- Verification environment constraints:
  - **E1**: no real IdP (Entra ID / Okta) is reachable from dev. SCIM requests are driven against the route handlers (integration tests in-process; manual `curl` with a SCIM token). How a given IdP schedules retries cannot be observed: `blocked-deferred`, justified in C6. The design does not depend on it.
  - **E2**: this worktree has its own database `passwd_sso_wt_1047` (enforce mode). `npm run test:integration` runs there, and `setup.ts`'s worker guard applies. CI's integration job picks up `src/**/*.integration.test.ts`. Every run is judged by exit code.

## Objective

When revoking a user's sessions and tokens fails on deprovisioning (SCIM PUT/PATCH `active=false`, SCIM DELETE, directory-sync deactivation), on team member removal, or on an admin vault reset, the request must not leave the state change committed while the credentials stay alive. A retry by the caller must perform the revocation.

## Why the post-commit call cannot be fixed by returning an error

Today the revocation (`invalidateUserSessions`) runs in its own transaction **after** the state change commits. Turning the swallowed error into an error response is not enough, because the retry it invites cannot reach the revocation:

- **SCIM DELETE**: the membership row and the externalId mapping are gone, so a retry resolves no user and gets 404 (`[id]/route.ts` resolve → `ScimUserNotFoundError`).
- **SCIM PUT/PATCH `active=false`**: `departFromTenant` stamps only rows where `deactivated_at IS NULL`. On a retry nothing transitions, the action becomes `SCIM_USER_UPDATE`, and `needsSessionInvalidation` is false.
- **Team member DELETE**: the row is gone, so a retry gets `MEMBER_NOT_FOUND`.
- **`vault/admin-reset`**: the reset token is spent (CAS on `executedAt`) and the vault wiped before the revocation, so a retry gets `VAULT_RESET_TOKEN_USED` (round-1 S1).

Making a retry re-run the revocation whatever the transition (always revoke on `active=false`) would fix PUT/PATCH and nothing else. A durable outbox/retry queue would add a worker-driven state machine for a write that fits in the existing transaction.

**Decision: atomic revocation.** The database half of the revocation runs inside the transaction that commits the departure or removal. Both commit or neither does. On failure the departure rolls back and the request fails. The member stays active, so a retry starts from the pre-departure state and transitions and revokes again. This holds whatever the IdP's retry policy (E1). An IdP that does not retry leaves a visibly failed deprovision rather than a silently half-done one.

**Trade-off (round-1 S6).** Before, a swallowed failure left the membership ended. `auth-gate.ts` and the token validators' membership re-checks then denied most access, but not the session-auth path to `DelegationSession`. After, a failure leaves the membership active and every credential alive until the retry succeeds. The state is consistent and loud (5xx/409 to the IdP or admin, an `ERROR` sync log and `lastSyncError` for directory sync). One user's failure rolls back a whole directory-sync run. That is the existing behaviour for any error in that transaction, and it is reported the same way.

Only the session-cache tombstones stay post-commit and best-effort, because Redis is not transactional with Postgres. The cache never authenticates on its own: handlers re-read the session row through `auth()` (`auth-adapter.getSessionAndUser`), and the proxy fails closed for a user with no active membership (`auth-gate.ts`). A surviving entry lets the proxy pass a request the handler then refuses, until `SESSION_CACHE_TTL_MS`. Failures are counted, logged at error level and sent to Sentry (C5).

## Site set (R42 member-set derivation)

### A. Every caller of `invalidateUserSessions`

`grep -rn "invalidateUserSessions(" src --include='*.ts' | grep -v '\.test\.'` (9 production calls):

| Site | Today on failure | Disposition |
|------|------------------|-------------|
| `scim/v2/Users/[id]` PUT / PATCH / DELETE | logged, 200/200/204 | **C3** atomic |
| `teams/[teamId]/members/[memberId]` DELETE | logged, 200 | **C4** atomic |
| `vault/admin-reset` | throws → 500 after token spent + wipe committed | **C7** revoke first |
| `vault/change-passphrase`, `vault/recovery-key/recover` | 500 `SESSION_INVALIDATE_FAILED` | unchanged: SC1 |
| `vault/reset` | throws → 500 after wipe | unchanged: SC2 |
| `vault/rotate-key` | returns `invalidationFailed` | out of scope per issue: SC3 |

### B. Other revocation helpers and tombstone copies

`grep -rn "revokeUserAuthArtifactsInTx\|invalidateTenantSessionsCache\|invalidateUserSessionsCache\|session.cache_tombstone_failures" src --include='*.ts' | grep -v '\.test\.'`:

- `revokeUserAuthArtifactsInTx`: `member-passkey-revoke.ts`. Already in-transaction; this plan's primitive generalises it (C1).
- `src/auth.ts` bootstrap → SSO migration: revokes inline in its transaction, so it is already atomic. Its post-commit tombstone block, like `member-passkey-revoke.ts`'s, is a hand copy of the signal and moves to C5 (round-1 func F1).
- `invalidateTenantSessionsCache` / `invalidateUserSessionsCache`: cache-only refreshes after policy or passkey changes. They revoke nothing, so they are out of class.

### C. Every writer that ends a tenant membership

The issue lists callers of the helper. The class is "a deprovisioning that commits without revoking". Derived from the writes that end a membership (`check-team-rotation-input-lock.mjs` rule 2 already confines the active-state writes to `team-departure.ts`; rule 5 forbids the adapter's `deleteUser`):

```
grep -rnE "SET deactivated_at = clock_timestamp|tenantMember\.(delete|deleteMany)\(|DELETE FROM tenant_members" src --include='*.ts' | grep -v '\.test\.\|__tests__'
```

- `team-departure.ts` `departFromTenant`: SCIM PUT/PATCH and directory sync (`engine.ts`, two calls).
- `team-departure.ts` `departCreatedMembership`: SCIM POST `active=false` and directory-sync create of a deactivated user.
- `scim-user-service.ts` `deactivateScimUser` (`tenantMember.delete`): SCIM DELETE.
- `src/auth.ts` bootstrap migration (`tenantMember.deleteMany`): revokes already (B).

**Delta against the issue's list:** directory sync deactivates members through `departFromTenant` and revokes **nothing**. Moving the revocation into `departFromTenant` (C2) covers it.

**Out of class (round-1 func F9):** team memberships that end without a tenant departure (`scim-group-service.ts` group removal, `scim-admission.ts` reject) revoke nothing today, and this plan does not change that. A team membership ending does not end the user's tenant credentials. C4's tenant-wide revocation on a team member DELETE is that route's existing behaviour, and this plan only makes it atomic. `returnToTenant` (reactivation) revokes nothing, by design.

## Contracts

### C1: Batch revocation primitive and bounded lock

`src/lib/auth/session/user-session-invalidation.ts`, `src/lib/auth/session/user-auth-serialization.ts`

```ts
export type UserAuthArtifactCounts = Omit<InvalidateUserSessionsResult, "cacheTombstoneFailures">;
export async function revokeUsersAuthArtifactsInTx(
  tx: Prisma.TransactionClient,
  userIds: readonly string[],
  options: { tenantFilter: { tenantId?: string }; excludeSessionDigest?: string | null; now?: Date; boundedLockWait?: boolean },
): Promise<{ counts: UserAuthArtifactCounts; sessionTokens: string[] }>;
export async function lockUsersAuthArtifacts(tx, userIds: readonly string[], options?: { bounded?: boolean }): Promise<void>;
export class UserAuthLockTimeoutError extends Error {}
```

- The same ten models, scope rules and statement order as today. The filters use `userId: { in }` (and `subjectUserId: { in }`), and counts are summed. `revokeUserAuthArtifactsInTx(tx, userId, opts)` keeps its signature and delegates with `[userId]`. An empty list means zero counts and no statements.
- `lockUsersAuthArtifacts` builds every key with `userAuthLockKey` (one source, byte-identical to what mints lock; ids are taken as given, since they come from database `RETURNING`/`select` and are lowercase). It takes all of them in ONE `$executeRaw` statement, ordered by key `COLLATE "C"`. With `boundedLockWait: true`, the wait goes through `withBoundedLockWait` with a **fresh** `createLockBudget()` taken at that point, and raises `UserAuthLockTimeoutError` (round-1 S2/F4). A caller's transition budget is never reused: directory sync's `transitionBudget` is spent by the run's own work, so reusing it would fail an uncontended large batch every run (round-3 F-R3-1). Without the flag (`invalidateUserSessions`, `member-passkey-revoke`), it waits as today. Accounting (round-5 F-R5-1): the SCIM routes and team DELETE make one revocation call, so their worst case is one team-lock wait plus one user-auth wait (2 × 3 s), under `TEAM_MEMBERSHIP_TX_TIMEOUT_MS` (10 s). Directory sync makes up to three revocation calls, so its worst case, 4 × 3 s, can exceed the transaction timeout, which then ends as P2028. That still rolls back in full, the run logs `ERROR`, and the next run retries. Accepted: threading one revocation budget through the run would re-couple it to the run's own work, which is F-R3-1's failure. `lockUserAuthArtifacts(tx, id)` stays the single-key form for mints.
- `isMembershipLockConflict` includes `UserAuthLockTimeoutError`. `membershipConflictMessage` gives it its own reason ("The user's sign-in state is being changed; retry later"), so a lock timeout during revocation is not reported as a key rotation.
- Deadlock: one call cannot deadlock on its own ordering. In every departure or removal transaction, the user-auth lock is the **last** lock taken, after that transaction's row writes (round-2 F-R2-1: a union lock taken earlier in directory sync would have reversed the order against C4's team DELETE, which holds the target's `team_members` row and then waits on user-auth). A transaction that revokes in several calls (directory sync, up to three) holds user-auth(A) while it locks B. A cycle would need a second transaction that holds user-auth(B) and waits on something of the first. Mints take no row locks. Departures and removals take user-auth last. Known cycles (round-3 F-R3-2; round-3 review checked every other pair):
- (a) The bootstrap migration of U holds user-auth(U) and then inserts the (T,U) membership. Meanwhile a SCIM POST or directory-sync create in T has inserted (T,U) deactivated and waits on user-auth(U) in `departCreatedMembership`.
- (b) Two tenants' syncs, where one holds user-auth(U) from an earlier departure call and the other's `departCreatedMembership` holds a later id and waits on U. `departCreatedMembership` locks users active in another tenant.
- (c) A departure from a user's bootstrap tenant concurrent with that user's migration (C2).

"Mints take no row locks" holds for every mint except the migration. All of these are detected by Postgres (40P01). It rolls the transaction back and surfaces as a 409 on routes or an `ERROR` sync run, with no partial commit.
- Contention (round-2 S-R2-3): the bounded wait means lock contention can refuse a deprovisioning with a 409. The departing user cannot starve it by minting repeatedly. Postgres grants a contended advisory lock in queue order, so a later mint queues behind the waiting revocation, and each mint holds the lock for one short transaction.
- Directory sync deactivates N users in one transaction. A per-user call would add 13 statements per user under `TEAM_MEMBERSHIP_TX_TIMEOUT_MS`; the batch form keeps the count constant.
- Control class: enforceable boundary for every writer that calls it (the revocation commits with the departure). Adjudication authority: the Postgres transaction.

### C2: Every tenant-membership end revokes in its own transaction

`src/lib/team/team-departure.ts`

```ts
export type DepartureRevocation = { counts: UserAuthArtifactCounts; sessionTokens: string[] };
export async function departFromTenant(tx, tenantId, userIds, options): Promise<{ userIds: string[]; revocation: DepartureRevocation }>;
export async function departCreatedMembership(tx, tenantId, userIds, options): Promise<DepartureRevocation>;
```

- `departFromTenant` revokes, scoped `{ tenantId }`, for exactly the transitioned ids, after `endTeamMemberships`, with `boundedLockWait: true`. A non-transition revokes nothing. This is the same set that today decides `needsSessionInvalidation`.
- `departCreatedMembership` revokes for its ids, so the invariant is "every membership end revokes" without exceptions to argue.
- Directory sync takes no extra lock: each departure call revokes its own ids last (C1). It collects every `sessionTokens` list and tombstones them once after the commit (C5). It logs the summed counts in a structured `directory-sync.credentials-revoked` line; the per-team `TEAM_MEMBER_TENANT_DEACTIVATE` audit rows and the sync log's `usersDeactivated` already record the departures (round-1 S7). The rest of directory sync is unchanged.
- Lock order: the revocation runs after `lockTenantRows` and the team locks. No holder of the user-auth lock waits on a lock these transactions hold:
  - Explicit locks: every file calling `lockUserAuthArtifacts` has 0 matches for `lockTenantRows|lockTenantMemberCreation|lockMemberTeams|lockTeamKeyVersion|lockActorThenTeam|FOR UPDATE|FOR SHARE` (loop over `grep -rl lockUserAuthArtifacts src --include='*.ts' | grep -v '\.test\.'`).
  - Implicit locks (round-1 F5/S2): mints INSERT rows whose FKs take `FOR KEY SHARE` on `users`, `tenants`, `mcp_clients` and `webauthn_credentials`. No departure transaction locks those `FOR UPDATE`; the directory-sync rename is a `NO KEY UPDATE`.
  - The bootstrap migration (`auth.ts`) takes user-auth and then deletes the user's bootstrap-tenant `tenant_members` row. A concurrent departure of that same row from the bootstrap tenant (held `FOR UPDATE`, then waiting on user-auth) would form a cycle. Postgres detects it, one side rolls back, and nothing half-commits. This is availability only, and it needs an IdP/sync acting on the bootstrap tenant while the user signs in.
- RLS: these functions run under the tenant context, where a bypass may not be nested. The `prisma` proxy hands the context's `tx` to the service's nested `$transaction` (`src/lib/prisma.ts`), so the revocation shares the departure's transaction. All ten tables have NOT NULL `tenant_id` and a `*_tenant_isolation` policy, so the tenant context reaches exactly the rows `{ tenantId }` names. T3 proves this on `passwd_app`.
- The doc comment of `user-auth-serialization.ts` ("its callers on SCIM deactivation and team removal carry on when it fails") and of `revokeUserAuthArtifactsInTx` ("The caller's bypass grant must cover …", which is now "the caller's context must reach …") are updated.
- Invariant (app-enforced, gate-held). A trigger on `tenant_members` that revokes the ten models was rejected. It would be a second implementation of the ten-model list beside C1 (R48), and `auth.ts`'s list is already one copy. It would also fire inside the bootstrap migration's `deleteMany`. That migration revokes only its source tenant's tokens and **moves** the sessions to the new tenant instead of deleting them (round-2 F-R2-3), which a revoking trigger would contradict. That is also why the migration cannot call C1 and keeps its own inline revocation.
- Control class: enforceable boundary for the listed writers. Membership of the writer set is held by C8, which is a review tripwire over source order with the pinned site set as its backstop, not a proof (round-2 F-R2-3).

### C3: SCIM `Users/[id]` PUT / PATCH / DELETE, and SCIM POST

- `deactivateScimUser` revokes (C1, `{ tenantId }`, `boundedLockWait: true`) inside its transaction, after the membership delete. `DeactivateResult` becomes `{ userId; revocation: DepartureRevocation }`.
- `replaceScimUser` / `patchScimUser` results replace `needsSessionInvalidation` with `revocation: DepartureRevocation | null`. It is non-null exactly when the action is `SCIM_USER_DEACTIVATE`.
- The routes stop calling `invalidateUserSessions`. After the commit they call `tombstoneRevokedSessions(revocation.sessionTokens, …)` and record `{ ...revocation.counts, cacheTombstoneFailures }` in the audit metadata. Those are the same keys as today; `sessionInvalidationFailed` is gone.
- SCIM POST tombstones `departCreatedMembership`'s `sessionTokens` after its commit. Its audit metadata is unchanged.
- A revocation failure propagates out of the transaction.
- Consumer-flow walkthrough:
  - `scim/v2/Users/[id]/route.ts` PUT/PATCH reads `{ snapshot, userId, auditAction, revocation }`. It tombstones `revocation.sessionTokens` and spreads `revocation.counts` into the audit metadata, both only when `revocation !== null`.
  - `scim/v2/Users/[id]/route.ts` DELETE reads `{ userId, revocation }` the same way.
  - `scim/v2/Users/route.ts` POST reads `{ sessionTokens }` from `departCreatedMembership`.
  - `directory-sync/engine.ts` reads `.userIds.length` for `usersDeactivated` (today `.length`), plus `revocation.sessionTokens` / `.counts` from each departure call.
  - Audit metadata consumers (audit log UI, download) render metadata generically. Nothing reads `sessionInvalidationFailed`: `grep -rn sessionInvalidationFailed src messages` finds only the two route files and their tests.

### C4: Team member DELETE

- `revokeUserAuthArtifactsInTx(tx, target.userId, { tenantFilter: { tenantId }, boundedLockWait: true })` runs inside the `withTeamTenantRls` transaction, after the member and key deletes. `tenantId` is the callback's argument.
- `withTeamTenantRls` gets `{ timeout: TEAM_MEMBERSHIP_TX_TIMEOUT_MS }`, as the SCIM routes do (round-1 F4). Today it runs on the 5 s default.
- After the commit, tombstones go through C5. The audit metadata is `{ removedUserId, removedRole, ...counts, cacheTombstoneFailures }`.
- Consumer: the team members UI reads `{ success: true }` (unchanged).

### C5: Post-commit tombstone helper (one signal)

`src/lib/auth/session/user-session-invalidation.ts`

```ts
export async function tombstoneRevokedSessions(
  sessionTokens: readonly string[],
  context: { reason: string | null; operation: string; userId?: string; extra?: Record<string, unknown> },
): Promise<number>; // failures
```

- Never throws: a throw from `invalidateCachedSessions` counts every token as failed, and the error log then carries `error: errorLogFields(err)` (round-3 F-R3-5). When failures > 0 it emits the error log `{ userId?, failures, reason, _logType: "session.cache_tombstone_failures" }` with message `session.cache_tombstone_failures`. It also sends `Sentry.captureMessage("session cache tombstone failures during " + operation, { level: "error", tags: { reason: reason ?? "unspecified" }, extra: { userId?, failures, ...extra } })`. `userId` appears only when given.

Adopters and their signal (round-2 F-R2-4):

| Adopter | `operation` / `reason` | Delta vs today |
|---|---|---|
| `invalidateUserSessions` | `invalidateUserSessions` / `options.reason ?? null`, with `extra: { tenantScope }` | none. Its tombstone stays inside its bypass callback, before commit: a tombstone that precedes a rollback only evicts a cache entry |
| `src/auth.ts` migration | `the bootstrap tenant migration` / `bootstrap_tenant_migration`, with `extra: { tenantScope }` | none |
| `member-passkey-revoke.ts` | `tenant member passkey revoke` / `tenant_member_passkey_revoke`, `extra: { targetUserId }`, no `userId` | gains the `_logType` error log on partial failure (an addition). A Redis throw is logged as `session.cache_tombstone_failures`, not `tenant.member_passkey_revoke_cache_invalidation_failed` |
| SCIM `Users/[id]` / POST, team DELETE | `SCIM user deprovisioning` / `scim_deprovision`, `team member removal` / `team_member_remove` | today they emit `…during invalidateUserSessions` with tag `unspecified`. The `_logType` and level are unchanged |
| directory sync | `directory sync` / `directory_sync_deprovision` | new signal (it tombstones nothing today) |

All deltas are recorded in the deviation log.
- Stays on per-digest `invalidateCachedSessions`. A directory-sync batch is one tenant's departing users' sessions; the commands queue on one Redis connection and per-token failure counts are kept. `invalidateCachedSessionsBulkByDigest` reports a pipeline failure as all-or-nothing (round-1 F2, Minor, see review).
- Control class: detection only. Recovery is the TTL plus the handler-side session re-read.

### C6: Response semantics

- A revocation failure raised by the database propagates like any other transaction failure: `withRequestLog` rethrows, and the client gets a 500.
- A lock-class failure (`UserAuthLockTimeoutError`, 40P01, P2028) is a membership lock conflict, answered with 409. SCIM routes carry C1's reason through `membershipConflictMessage`. Team routes answer through `membershipConflictResponse` with `API_ERROR.CONFLICT` and no reason text, as for every other conflict (round-2 F-R2-5).
- In both cases nothing committed. No new `API_ERROR` code: `SESSION_INVALIDATE_FAILED` means "your change committed but other sessions survive", and that state no longer exists on these routes.
- E1 `blocked-deferred`: confirming a vendor's retry schedule for 500 vs 409 needs a live IdP tenant. That buys nothing the design relies on, because the rollback holds either way and the IdP surfaces both statuses as a failed operation.

### C7: `vault/admin-reset` revokes before the token is spent

- After every pre-check passes (token valid, owned, unexpired, unspent, approved, no vault rows outside the tenant) and **before** the token CAS, the route calls `invalidateUserSessions(userId, { allTenants: true, reason: "admin_vault_reset" })`. This is the same call and scope as today, moved earlier.
- A failure propagates as a 500. The token is unspent and the vault intact, so the user retries the same link.
- After a success, a CAS or wipe failure leaves the user signed out everywhere with the vault intact. Revocation is the safe direction, and the target user is the actor. The existing refusals (`VAULT_RESET_TOKEN_USED`, outside-tenant, rotation conflict) are answered as today.
- The completion audit row keeps its counts. They come from the earlier call.
- Right after the revocation succeeds and before the CAS, the route emits `SESSION_REVOKE_ALL` (personal scope, as `DELETE /api/sessions` does) with `{ reason: "admin_vault_reset", resetId, revokedCount: counts.sessions, ...counts }`. `revokedCount` is the field the audit page's renderer shows (round-4 F-R4-3). The label reads "Revoked all other sessions"; this revocation includes the current one. That wording mismatch is accepted, because rewording would change the label's meaning for `DELETE /api/sessions`. The record's audience is the target user: the credentials are theirs, and they acted. The admins see the reset's own state, the token spent with no completion row (round-4 S-R4-1). Every exit after the revocation therefore has a record: the CAS miss, `VaultResetOutsideTenantError`, a rotation conflict, a rethrow, or success (round-2 S-R2-2, round-3 S-R3-1). An existing action is reused rather than a `phase: "aborted"` row under `ADMIN_VAULT_RESET_EXECUTE`, which the audit UI labels "Admin vault reset executed" and tenant webhooks receive as one (round-3 F-R3-3). The success path keeps `ADMIN_VAULT_RESET_EXECUTE` "committed" then "completed".
- Window (round-2 S-R2-1): a credential minted between the revocation commit and the wipe commit survives the reset. Minting in that window needs a fresh primary sign-in, because every refresh path, bridge code and session was just revoked. That is the same power as signing in right after the reset. The target user is the actor and requested the reset. Accepted rather than adding a second post-wipe revocation, which would reintroduce a post-commit call whose failure has no retry.
- Consumer: the admin-reset page reads `{ success }` and error codes (unchanged).

### C8: AST gate rule: a membership end revokes in its function

`scripts/checks/check-team-rotation-input-lock.mjs`, new rule 9 (round-1 S3 / test F7):

- **Membership-ending write** (rule 9's subject): a `tenantMember` `delete`/`deleteMany` (any receiver), or a raw write whose target is `tenant_members` and that is a DELETE, or assigns `deactivated_at` anything but the literal `NULL`. Raw writes are classified from `scripts/checks/lib/sql-scan.mjs` tokens: `analyzeSql` for UPDATE/UPSERT/MERGE/DELETE, and rule 9 reads a plain `INSERT INTO tenant_members` head from the tokens itself, without adding INSERT to `WRITE_KIND`, whose existing consumers read that set (round-4 F-R4-2). Fail closed: each of these counts as ending (round-5 S-R5-2):
  - an assignment rule 9 cannot read;
  - an opaque target (`analyzeSql` `target.name: null`);
  - any `unrecognisedWrites` entry in a template that names `tenant_members`;
  - a MERGE whose INSERT arm or any SET names `deactivated_at`;
  - an INSERT, whether plain or the insert half of an upsert, whose column list names `deactivated_at` or that has no column list.

  Inside the `IMPLEMENTATIONS` files only, where rule 2 does not run, a Prisma write is also a subject when it is one that rule 2's `classifyTenantStateWrite` would classify (its method set, including `updateManyAndReturn`, `createMany` and `createManyAndReturn`, and `mayName`'s fail-closed handling of spreads and unreadable payloads) and it names `deactivatedAt` with anything but `null` (round-5 S-R5-1). Elsewhere, rule 2 already confines such writes: no update may name it, and a create must be followed by `departCreatedMembership`, which revokes. So the SCIM POST and directory-sync creates are rule-2 sites, not rule-9 sites, and one write has one adjudicator (round-4 F-R4-1, R48).
- Every function containing a subject must call `revokeUsersAuthArtifactsInTx` or `revokeUserAuthArtifactsInTx` after it in the same function.
- The rule runs **before** the `IMPLEMENTATIONS` skip, as rule 7's repo-wide checks do, because `team-departure.ts` is in `IMPLEMENTATIONS` (round-2 F-R2-2).
- The `src/auth.ts` bootstrap migration's `tenantMember.deleteMany` is exempted through the existing `EXEMPTIONS` map, whose key must match exactly one site. Its reason is in C2.
- "Same function" is the innermost enclosing function, the gate's existing `enclosingFunction()`. For `deactivateScimUser` that is its `prisma.$transaction(async (tx) => …)` callback, so a revocation placed after the `$transaction` fails, which is intended.
- Positive control: the expected sites, pinned by gate key, are found exactly:
  - `membership-end::src/lib/team/team-departure.ts::departFromTenant::<site>` (raw UPDATE);
  - `membership-end::src/lib/team/team-departure.ts::departCreatedMembership::<site>` (raw UPDATE);
  - `membership-end::src/lib/services/scim-user-service.ts::<anonymous>::tenantMember.delete` (inside `deactivateScimUser`);
  - plus the exemption `membership-end::src/auth.ts::<anonymous>::tenantMember.deleteMany`.

  The `<site>` suffix for raw writes is whatever the gate's `keyOf` builds; the keys are matched literally (round-5 F-R5-2).

  A missing expected site fails as loudly as an unexpected one (round-3 F-R3-4).
- Control class: review tripwire over source order (the gate's KNOWN LIMITS: an early return between the write and the revocation is not seen), with the pinned site set as the backstop.
- Self-test fixtures, each red-proved separately:
  - red: Prisma delete, Prisma `updateMany` / `updateManyAndReturn` / `create` with `deactivatedAt: new Date()` at the `team-departure.ts` path, a column-less `INSERT INTO tenant_members VALUES (…)`, an upsert whose INSERT columns name `deactivated_at` and whose `DO UPDATE SET` does not, raw DELETE, raw UPDATE `= clock_timestamp()`, raw UPDATE with an interpolated value, raw INSERT … `deactivated_at`, `ON CONFLICT DO UPDATE SET deactivated_at`, and a revocation called before the write. Each is placed at the `team-departure.ts` path;
  - harness (round-5 T-R5-2): `scripts/__tests__/check-team-rotation-input-lock.test.mjs` seeds the pinned rule-9 sites and the `auth.ts` migration shape. Each red **adds** its write to the seeded file rather than replacing it, and asserts its own rule-9 violation text, so a red cannot pass on "missing expected site".
  - allow: the `returnToTenant` shape (`SET deactivated_at = NULL … WHERE … deactivated_at IS NOT NULL`), and the SCIM-POST shape outside the IMPLEMENTATIONS files (a conditional `deactivatedAt` create followed by `departCreatedMembership`). The latter passes rule 9 and still fails rule 2 without the `departCreatedMembership` call.

### Forbidden patterns

- `pattern: invalidateUserSessions\( — reason: must not appear in scim/v2/Users/[id]/route.ts or teams/[teamId]/members/[memberId]/route.ts`
- `pattern: needsSessionInvalidation — reason: the service→route boolean is what let a retry skip the revocation`
- `pattern: sessionInvalidationFailed — reason: the swallowed-failure state no longer exists`

### Acceptance criteria

- AC1: with the revocation forced to fail (real DB), SCIM PATCH `active=false`, PUT `active=false` and DELETE answer 500. Every row the transaction would change is unchanged: the membership, team memberships, team keys, pending invitations, external mapping, departure record, sessions and tokens. No deactivate/delete audit row is enqueued.
- AC2: retried with the fault removed, the request transitions: PUT/PATCH audit action `SCIM_USER_DEACTIVATE`, DELETE 204 (not 404). It also revokes.
- AC3: AC1 and AC2 for team member DELETE.
- AC4: a directory-sync deactivation revokes the user's artifacts in the tenant.
- AC5: a departure through the production path, under the tenant context on `passwd_app`, revokes all ten models, with counts of 1 each.
- AC6: admin-reset with the revocation forced to fail: 500, token unspent, vault rows intact. The retry wipes and revokes.
- AC7: a departure with no transition (an already-deactivated member) revokes nothing and returns `revocation: null`.

## Testing strategy

**T1** (integration, new `session-revocation-atomic-departure.integration.test.ts`: SCIM PUT, PATCH, DELETE and team DELETE). Fault injection:
- Seed the user with a session, an extension token, an MCP access token, and an `mcp_authorization_codes` row (with its `mcp_clients`). Also seed a team membership with a key, a pending invitation they issued, and the external mapping.
- Fault: a `BEFORE UPDATE` trigger on `mcp_authorization_codes` (the last revoked table), `WHEN (OLD.user_id = <seeded>)`. It raises only `IF NOT EXISTS (SELECT 1 FROM sessions WHERE id = <seeded session>)`, so the raise itself proves the earlier session delete ran in the faulted transaction.
- The function uses a fixed routine name, which gets a `check-bypass-rls` `FUNCTION_RULE_ALLOWLIST` entry. It is created on `ctx.su` with `DROP … IF EXISTS … CASCADE` first and dropped in `finally` (RT11), following the `departed-member-leaked-authority` precedent.

The trigger raises a distinctive message (`T1_REVOCATION_FAULT`). The session is seeded in the transaction's tenant, so RLS cannot hide it from the trigger. Before the call, the test asserts that the trigger's predicate is false.

Assertions:
- Snapshot every listed row before the call; after it, `toEqual(before)`.
- The response is 500.
- The error the route rethrew (captured through a spy on `withRequestLog`'s logger, or by calling the unwrapped handler) carries `T1_REVOCATION_FAULT`. This proves the 500 came from the faulted revocation and not from an earlier failure (round-2 T-R2-1).
- No audit outbox row.
- Then drop the fault, retry, and assert AC2.

T1 and T7 share one file, so one `FUNCTION_RULE_ALLOWLIST` entry covers them (round-2 T-R2-3).

Red-proof on a scratch copy of the pre-change source: the fault case answers 2xx with the member deactivated. A second red: an unseeded faulted table makes the cell fail.

**T2** (integration): directory-sync deactivation revokes (AC4). With T1's fault armed, a sync run that deactivates the seeded user:
- logs `ERROR` and sets `lastSyncError`;
- leaves the membership active and all artifacts live;
- enqueues no `TEAM_MEMBER_TENANT_DEACTIVATE` row.

The next run, with the fault dropped, deactivates and revokes (round-2 T-R2-2). A created-deactivated user (SCIM POST and directory-sync create) with a leftover artifact in the tenant ends with it revoked (`departCreatedMembership`).

**T3** (integration): AC5 through `withTenantRls(prisma, tenantId, tx => departFromTenant(…))` with `assertRlsApplies`, all ten seeded rows live before and revoked after, and counts of 1. The cross-tenant-survival cell states that it pins RLS. `tenantFilter` itself is pinned by T4.

**T4** (unit):
- `revokeUsersAuthArtifactsInTx`: an empty list makes no calls. With two ids it uses one lock statement whose keys equal `userAuthLockKey(id)` byte for byte, filters with `in`, and carries `where.tenantId`.
- The C5 helper never throws, reports failures, and emits the same log type and message text per adopter.
- Route units let the transaction mock run its callback and make the revocation primitive reject inside it. They assert no 2xx, no deactivate/remove audit call and no tombstone call. Red: today's route with `invalidateUserSessions` rejecting answers 2xx.
- Paired success case: tombstone called with the `sessionTokens` the mocked departure derived from its arguments, and counts in the metadata.

**T5** (gate self-test): C8 fixtures, one red per clause, plus the allow fixture.

**T6** (integration, lock identity, round-1 test F4):
- A held transaction calls `revokeUsersAuthArtifactsInTx([other, userId])` **without** a pre-lock. A concurrent mint of `userId` parks on `pg_advisory_xact_lock` (witnessed through `pg_blocking_pids`) and creates nothing after the commit. Red-proof: change the key prefix in the batch path.
- A bounded-wait cell: hold A's user-auth lock past `TEAM_KEY_LOCK_TIMEOUT_MS` and run a SCIM deprovision of A. It fails with `UserAuthLockTimeoutError`, and the SCIM route answers 409 with the new reason; the budget is the fresh one C1 creates, so no seam is needed (round-3 T-R3-2). Allow side: release within the budget and the request succeeds.
- A fresh-budget cell (round-3 F-R3-1), unit level: a departure with `alreadyLocked: true` of a user with no active team membership (so no budgeted lock precedes the revocation), whose transition budget is already spent, still revokes; the revocation lock statement is asserted to have run (round-4 T-R4-1). Allow pair: a live budget with teams still departs and revokes. Red: pass the transition budget to the revocation lock.
- A lock-order cell (round-2 F-R2-1, round-3 T-R3-1):
  - Park a team DELETE of user A **between its key delete and its revocation, without touching user-auth**. The park is a test-only `BEFORE DELETE` trigger on `team_member_keys` (filtered to A) that waits on a test-held advisory key. It gets its own `FUNCTION_RULE_ALLOWLIST` entry, drop-before-create, and is dropped in `finally`.
  - Start a directory sync that departs A.
  - Witness through `pg_blocking_pids` that the sync is parked on the team DELETE's pid, and through `pg_locks` that the sync holds no `user-auth:` advisory lock.
  - Release the key. Both commit, with no 40P01.
  - Red-proof on a scratch copy: take user-auth before `endTeamMemberships` in `departFromTenant`, and the cell gets 40P01.
  - Allow side: AC4 without a concurrent writer.

**T7** (integration): AC6 for admin-reset, with the fault from T1. The revocation here runs under bypass, so the same trigger fires. The rate limiter is made to pass explicitly.

Unit cells in `admin-reset/route.test.ts` (round-2 T-R2-4):
- `invalidateUserSessions` is called once, before the token `updateMany`.
- A CAS miss after a successful revocation answers `VAULT_RESET_TOKEN_USED`, with exactly one `SESSION_REVOKE_ALL` audit call whose metadata has `revokedCount === counts.sessions`, `reason: "admin_vault_reset"` and `resetId`, and no `ADMIN_VAULT_RESET_EXECUTE` (round-5 T-R5-1).
- An `executeVaultReset` generic rejection gives a 500, again with the one `SESSION_REVOKE_ALL` call.
- Paired with the success order.

**T8** (integration): AC7 for PATCH, with the paired transitioning case from T1.

**Existing tests that change** (round-1 test F6, func F6):
- Unit: `scim/v2/Users/[id]/route.test.ts`, `scim/v2/Users/route.test.ts`, `teams/[teamId]/members/[memberId]/route.test.ts`, `scim-user-service.test.ts`, `directory-sync/engine.test.ts`, `user-session-invalidation.test.ts` (`where` shapes; the L2 fail-open comment), `user-auth-artifacts.member-set.test.ts` (the batch lock stays on `$executeRaw`), `vault/admin-reset/route.test.ts` (call order), `member-passkey-revoke` tests, and the `auth.ts` migration tests that assert the tombstone signal.
- Integration: `team-tenant-departure.integration.test.ts`, `departed-member-operator-scripts.integration.test.ts`, `team-tenant-departure-directory-sync.integration.test.ts`, `team-key-version-guard.integration.test.ts`, and `vault-reset-cache-tombstone-redis-failure.integration.test.ts` (the regression net for C5).

Both `npx vitest run` and `npm run test:integration` must exit 0. Each new test is red-proved on a scratch copy, never on the real tree.

## Files to update

`src/lib/auth/session/user-session-invalidation.ts`, `user-auth-serialization.ts`, `src/lib/team/team-departure.ts`, `src/lib/team/tenant-row-lock.ts` (conflict mapping), `src/lib/services/scim-user-service.ts`, `src/app/api/scim/v2/Users/[id]/route.ts`, `src/app/api/scim/v2/Users/route.ts`, `src/app/api/teams/[teamId]/members/[memberId]/route.ts`, `src/lib/directory-sync/engine.ts`, `src/app/api/vault/admin-reset/route.ts`, `src/lib/tenant/member-passkey-revoke.ts`, `src/auth.ts`, `scripts/checks/check-team-rotation-input-lock.mjs` (+ its self-test), `scripts/checks/check-bypass-rls.mjs` (`FUNCTION_RULE_ALLOWLIST`), `docs/security/cryptography-whitepaper.md` (the "revoked via `invalidateUserSessions`" line), plus the tests listed above.

## Scope contract

- **SC1**: `vault/change-passphrase`, `vault/recovery-key/recover`. They answer `SESSION_INVALIDATE_FAILED` to the acting user, who is the session holder, and the UI tells them. A retry reaches the revocation: change-passphrase with the new passphrase, recover with the same recovery key. The issue names them as the model. Unchanged.
- **SC2**: `vault/reset` (self). A retry re-runs `executeVaultReset`, which then deletes nothing and revokes, so the revocation is reachable. Its generic 500 does hide that the wipe committed. Changing that response is a UI/error-code change outside the defect class. Unchanged.
- **SC3**: `vault/rotate-key`, out of scope per the issue.
- **SC4**: a SCIM-envelope body for the 500. Every other unexpected failure on these routes answers the same way today. Unchanged.

## User operation scenarios

1. Entra ID PATCHes `active=false` and the database rejects a token revocation. Entra sees 500 and the user is still active. The next cycle's PATCH succeeds and the user's sessions die.
2. An Okta DELETE fails the same way. The user is still a member, so the retry does not get 404: it removes the user and revokes.
3. A team admin's removal fails with 500 and the member is still listed. Retrying removes them and ends their tenant sessions.
4. A nightly directory sync drops a user. The run deactivates them and revokes their sessions in the same transaction. A revocation failure fails the whole run (`ERROR` log), and the next run retries.
5. The PATCH is retried after a success. Nothing transitions, so nothing is revoked (it already was, atomically), and the response is 200 `SCIM_USER_UPDATE`.
6. A user runs an admin-approved vault reset while revocation fails. They see an error, but their vault and reset link are intact; retrying the link completes it.
7. Revocation waits on a concurrent sign-in past the lock budget. The IdP gets 409 "sign-in state is being changed", and nothing has committed.

## Go/No-Go Gate

| ID  | Subject                                                     | Status |
|-----|-------------------------------------------------------------|--------|
| C1  | Batch revocation primitive and bounded lock                 | locked |
| C2  | Every tenant-membership end revokes in its own transaction  | locked |
| C3  | SCIM Users/[id] PUT/PATCH/DELETE and POST atomic            | locked |
| C4  | Team member DELETE atomic                                   | locked |
| C5  | Post-commit tombstone helper (one signal)                   | locked |
| C6  | Response semantics                                          | locked |
| C7  | admin-reset revokes before the token is spent               | locked |
| C8  | AST gate rule 9: a membership end revokes in its function   | locked |

## Implementation Checklist

Production (C1–C7):
- `src/lib/auth/session/user-session-invalidation.ts`: add `revokeUsersAuthArtifactsInTx`; make `revokeUserAuthArtifactsInTx` delegate; export `UserAuthArtifactCounts`; add `tombstoneRevokedSessions`; `invalidateUserSessions` uses the helper; update the doc comments.
- `src/lib/auth/session/user-auth-serialization.ts`: add `lockUsersAuthArtifacts` and `UserAuthLockTimeoutError`; update the doc comment.
- `src/lib/team/tenant-row-lock.ts`: add `UserAuthLockTimeoutError` to `isMembershipLockConflict` and `membershipConflictMessage`.
- `src/lib/team/team-departure.ts`: `departFromTenant` and `departCreatedMembership` revoke and return the revocation.
- `src/lib/services/scim-user-service.ts`: replace `needsSessionInvalidation` with `revocation`; `deactivateScimUser` revokes in its transaction.
- `src/app/api/scim/v2/Users/[id]/route.ts`, `src/app/api/scim/v2/Users/route.ts`, `src/app/api/teams/[teamId]/members/[memberId]/route.ts`, `src/lib/directory-sync/engine.ts`, `src/app/api/vault/admin-reset/route.ts`.
- `src/lib/tenant/member-passkey-revoke.ts`, `src/auth.ts`: adopt the C5 helper.
- `docs/security/cryptography-whitepaper.md`: fix the "revoked via `invalidateUserSessions`" line.

Gate (C8): `scripts/checks/check-team-rotation-input-lock.mjs` rule 9 + `scripts/__tests__/check-team-rotation-input-lock.test.mjs`. `scripts/checks/check-bypass-rls.mjs` `FUNCTION_RULE_ALLOWLIST` gets entries for the new integration test routines.

Shared utilities to reuse (no reimplementation):
- `withBoundedLockWait`, `createLockBudget` (`team-key-rotation-lock.ts`)
- `userAuthLockKey` (`user-auth-serialization.ts`)
- `invalidateCachedSessions` (`session-cache-helpers.ts`)
- `errorLogFields` (`logger/error-fields`)
- `isMembershipLockConflict` / `membershipConflictMessage` / `membershipConflictResponse`
- `TEAM_MEMBERSHIP_TX_TIMEOUT_MS`
- `personalAuditBase` + `AUDIT_ACTION.SESSION_REVOKE_ALL`
- the gate's `enclosingFunction` / `functionName` / `keyOf` / `EXEMPTIONS` / `classifyTenantStateWrite` / `mayName`
- `scripts/checks/lib/sql-scan.mjs` `analyzeSql`
- integration helpers in `src/__tests__/db-integration/helpers.ts` (`createTestContext`, `assertRlsApplies`, race helpers)

Test trees touched (R19, from `grep -rl` across `src` and `scripts`):
- `departFromTenant`: `team-tenant-departure.integration`, `departed-member-operator-scripts.integration`, `scim/v2/Users/[id]/route.test`, `scim-user-service.test`, `directory-sync/engine.test`, `check-team-rotation-input-lock.test.mjs`
- `departCreatedMembership`: `team-tenant-departure-directory-sync.integration`, `scim/v2/Users/route.test`, `engine.test`, the gate test
- `deactivateScimUser`: `team-key-version-guard.integration`, `scim-user-service.test`, the gate test
- `revokeUserAuthArtifactsInTx`: `user-auth-serialization.integration`, `tenant/members/[userId]/passkeys{,/[credentialId]}/route.test`, `user-auth-artifacts.member-set.test`
- `invalidateUserSessions`: all 20 test files listed by `grep -rl invalidateUserSessions`, which must stay green

CI parity: `scripts/pre-pr.sh` already queues `check-team-rotation-input-lock` and `check-bypass-rls`, plus the other static gates CI runs. No gap found. `npm run test:integration` is not part of pre-pr and runs separately on `passwd_sso_wt_1047`.
