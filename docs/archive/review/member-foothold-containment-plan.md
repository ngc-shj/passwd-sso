# Plan: member-foothold-containment (`#1032`, folds in `#1045` SC1)

## Project context

- Type: web app (Next.js App Router + Prisma 7 + PostgreSQL 16 with FORCE RLS, Auth.js v5
  database sessions) plus the audit-outbox worker process.
- Test infrastructure: unit + real-DB integration + E2E + CI/CD.
- Verification environment constraints: none blocking. This worktree has its own database
  (`passwd_sso_wt_1032`), so integration tests do not race the dev workers. All paths are
  `verifiable-local` / `verifiable-CI`.

## Objective

`#1031` (`#1016`) lets an admin contain a compromised member's footholds that carry a stored creator
column. `#1032` asks, per remaining kind, for a creator column plus containment or an audit-based
review; `#1045` SC1 asks what happens to the same footholds when their creator departs the tenant.

## Foothold kinds (derived from the code, not the issue's table)

Derivation: every model with a user column — `awk '/^model /{m=$2} /^\s+[a-zA-Z]+(Id|ById)\s+String/ {print m": "$1" "$2}' prisma/schema.prisma`
— plus every tenant-scoped model holding a credential, delivery destination or standing grant
without one (`TenantWebhook`, `AuditDeliveryTarget`, `DirectorySyncConfig`, `ScimGroupMapping`,
`TenantClaim`, policies). For each, the use-time path was read for whether it keeps working once
its creator departs (`departFromTenant`, `src/lib/team/team-departure.ts`).

### Already closed (no change)

| Kind | Why closed |
|---|---|
| API keys, extension tokens, MCP access/refresh tokens, delegation sessions, operator tokens, bridge/auth codes | Subject is the user: `revokeUsersAuthArtifactsInTx` revokes them on every departure (`#1064`) and on revoke-all. Operator tokens: the mint route sets `createdByUserId` = `subjectUserId`. |
| Team webhooks | Paused at delivery once the creator lost team authority (`webhook-creator-authority.ts`, `#1043`). |
| Team share links | `share_creator_admitted()` refuses after the creator's departure (`#1055`). |
| Team invitations | Expired on departure (`endTeamMemberships`); accept re-checks the inviter. |
| Break-glass grants | The logs route requires an active membership with `AUDIT_LOG_VIEW`. Containment revokes them. |
| JIT access requests | Approvable after the requester leaves, but the token goes to the approver. |
| Emergency-access grants | The owner's own vault escrowed to their grantee, not tenant authority. Containment revokes them. |

### Decided per kind (owner, 2026-11-16: "accept as recommended"; split as recommended)

| # | Kind | Decision | In this PR |
|---|---|---|---|
| K1 | Service-account tokens (`created_by_id`) | Revoke in the departure transaction | yes (C4, C5, C6) |
| K2 | SCIM tokens (`created_by_id`) | No auto action (revoking cuts the IdP's provisioning, including the call deprovisioning the minter); the list flags a token whose minter lost authority | yes (C6) |
| K3 | MCP clients, confidential (`created_by_id`) | No auto action (the secret alone gets no token; no `client_credentials`); flagged like K2 | yes (C6) |
| K4 | Tenant webhooks (no creator) | Add `created_by_id`; pause at delivery like team webhooks; containment can remove them | yes (C3, C7) |
| K5 | Audit delivery targets (no creator) | Add `created_by_id`; containment only, no auto pause (would cut security monitoring) | SC1 |
| K6 | Admin vault resets the member initiated, not yet approved | Revoke on departure; containment can revoke | yes (C4, C5, C7) |
| K7 | Personal share links and Sends | Serve until expiry (≤ 30 days) after departure; containment can revoke | SC2 |
| K8 | Team share-link access logs via `shareLinkManagerOf` (`#1032` comment) | Creator path requires current team membership | yes (C8) |
| K9 | Audit-only changes (role/policy, directory-sync configs, SCIM group mappings, edits to others' rows) | Actor filter on tenant audit logs, linked from containment | SC3 |
| — | Service accounts themselves; directory-sync credentials | No action: a service account holds no credential (its tokens are K1); directory-sync credentials are the IdP's | — |

Interpretation of the split answer ("containment entries for K4–K6" vs "follow-up: K5"): K5 goes
to the follow-up entirely, so containment gains K4 and K6 here.

## Requirements

- R1: a tenant webhook delivers only while its creator is an active member of the tenant whose
  role holds `WEBHOOK_MANAGE` and who has not left the tenant (departure record) since creating it;
  a webhook created before the column (NULL) keeps delivering; the list shows the paused state.
- R2: every departure and every return revokes, in its transaction, the live service-account
  tokens the user minted in the tenant and the unapproved, unexecuted, unrevoked, unexpired vault
  resets they initiated there, audited in the transaction.
- R3: a token mint, a reset initiate and a reset approve cannot commit for an actor whose
  departure or demotion has committed (serialization on the tenant row); approve also refuses a
  reset whose initiator lacks current authority.
- R4: the SCIM-token, MCP-client and service-account-token lists flag a row whose creator lacks
  current authority.
- R5: the containment dialog lists and removes the member's tenant webhooks and pending vault
  resets.
- R6: a team link's creator reads its access log only while a current (non-leftover) member of the
  team; revoke is unchanged.

## Technical approach

- The tenant permission table moves to an import-safe module (the worker must not load
  `@/lib/prisma`, which `tenant-auth.ts` imports), mirroring `team-permissions.ts`.
- One creator-authority helper, built on `readTenantRows` (`tenant-departure-read.ts`, already
  worker-safe and worker-granted), answers "does this row's creator still hold permission P" for
  the worker, the app dispatcher and the four list routes.
- The departure revocation is a sibling module; `team-departure.ts` and `scim-user-service.ts`
  gain one call per departure writer, after the credential lock.

## Contracts

### C1 — Import-safe tenant permissions
`src/lib/auth/access/tenant-permissions.ts`: the role table, `type TenantPermission`,
`hasTenantPermission(role, permission): boolean`; no server imports. `tenant-auth.ts` re-exports
both names, so existing importers are unchanged.

### C2 — Creator authority
`src/lib/tenant/creator-authority.ts` (import-safe):
`creatorVerdicts(tx: Pick<Prisma.TransactionClient, "tenantMember" | "tenantMemberDeparture">,
tenantId: string, rows: readonly { id: string; createdById: string | null; createdAt: Date }[],
permission: TenantPermission): Promise<Map<string, "legacy" | boolean>>` keyed by row id:
"legacy" for a NULL creator; true iff the creator's tenant row (one `readTenantRows` call) is
present, `deactivatedAt = null`, its role holds `permission`, and not `departedSince(row, createdAt)`
(`tenant-departure-read.ts`, mirrored in SQL by `share_creator_admitted`; SEC-6) — a creator
hard-deleted after creating the row and re-created later does not revive it (SF8). Shape follows
`webhook-creator-authority.ts`; the team helper is not refactored onto it (F7-r2). A missing entry is read as false by every caller.
- Control class: fail-closed verification gate. Adjudication authority: the `tenant_members` row
  and `tenant_member_departures` record read in the caller's transaction.

### C3 — Tenant webhook creator (K4)
- Prisma model + migration: `tenant_webhooks.created_by_id UUID` (no FK, as `team_webhooks`; the
  schema-derived user-bound gates therefore do not enumerate it — by design, as for team webhooks),
  backfilled from the latest `TENANT_WEBHOOK_CREATE` (actor HUMAN, scope TENANT, same tenant,
  `metadata.webhookId`) in `audit_logs`, else an undrained `audit_outbox` row, in a bypass-GUC `DO`
  block like `20261114000300_team_webhook_creator`. No new worker grant: it holds table SELECT on
  `tenant_webhooks` and column SELECT on `tenant_members` / `tenant_member_departures`
  (20261115000200).
- POST sets `createdById: session.user.id`.
- Delivery readers (member set, pinned by C10): worker `resolveWebhookSubscribers` tenant branch and
  `dispatchTenantWebhook`. Both deliver only on `true` / "legacy" (C2, `WEBHOOK_MANAGE`); a skip logs
  `outbox.webhook_creator_unauthorized` with `scope: "TENANT"` (worker, `_logType`) / a warn in the
  dispatcher. `BYPASS_GRANT.TENANT_WEBHOOK_DISPATCH` gains `tenantMember`, `tenantMemberDeparture`;
  `check-bypass-rls` is run, and the read is reached through a call it can attribute (inlined in the
  callback if the gate cannot see through the helper).
- GET: `creatorAuthorized: boolean | null` (null = legacy); `createdById` stays server-side.
- Consumer: `TenantWebhookCard` → `base-webhook-card.tsx` reads `creatorAuthorized`, renders
  `creatorPaused` (new key in `messages/{en,ja}/TenantWebhook.json`) when `false`.

### C4 — Departure revocation (K1, K6)
`src/lib/tenant/departure-footholds.ts`:
`endCreatorFootholdsInTx(tx, tenantId: string, userIds: readonly string[], actor:
DepartureAuditActor): Promise<void>`.
- Call sites (member set, pinned by C10): `departFromTenant`, `returnToTenant`,
  `departCreatedMembership` (transitioned users) and `deactivateScimUser` (SCIM DELETE; gains an
  `actor: DepartureAuditActor` parameter built by its route with `departureActor(...)` as PUT/PATCH
  do). Each calls it AFTER `revokeUsersAuthArtifactsInTx` / `revokeUserAuthArtifactsInTx`, so its
  row locks come after the credential lock, as in containment (credential lock → foothold rows; FF2).
  Exempt: the bootstrap-tenant migration in `src/auth.ts` (the sole member is that tenant's OWNER,
  whom `departFromTenant` also never departs).
- Service-account tokens: `{ tenantId, createdById: { in }, revokedAt: null, expiresAt: { gt: now } }`
  → `revokedAt = now` (`updateManyAndReturn`). One `SERVICE_ACCOUNT_TOKEN_REVOKE` per token
  (targetType SERVICE_ACCOUNT_TOKEN, `metadata: { serviceAccountId, targetUserId: creator, reason:
  "CREATOR_DEPARTED" }`).
- Vault resets: `{ tenantId, initiatedById: { in }, approvedAt: null, executedAt: null, revokedAt:
  null, expiresAt: { gt: now } }` → `revokedAt = now, encryptedToken = null`. One
  `ADMIN_VAULT_RESET_REVOKE` per reset (targetType User, targetId the reset's target, `metadata:
  { resetId, initiatedById, reason: "INITIATOR_DEPARTED" }`). No target notification (an unapproved
  reset was never announced to the target, the revoke route's F2 rule). Approved resets stay: a
  present admin endorsed them (C5 serializes that approval).
- Audit via `logAuditBulkInTx` with the departure's actor. On `returnToTenant` it sweeps what an
  earlier, pre-upgrade departure left (SF2); `reason` stays as above.

### C5 — Foothold writes serialize with departure, demotion and containment
A shared helper in `src/lib/tenant/foothold-write-gate.ts`:
`lockFootholdWriter(tx, req, { tenantId, actorId, permission, alsoLock?: string[], budget }):
Promise<Map<string, LockedTenantRow>>` — the FIRST statement of the writing transaction, before
the route's own `advisoryXactLock` (C10 pins the position):
1. `lockTenantRows(tx, tenantId, [actorId, ...alsoLock], "share", budget)` — ONE call (sorted; the
   gate's rule against a second call);
2. refuse unless the actor's row is present, active and its locked role holds `permission`;
3. `lockUsersAuthArtifacts(tx, [actorId], { bounded: true })` then `isSessionRowLive(tx, req,
   actorId)` — the containment fence (SEC-1).
Callers take every other user's active state and role from the returned map (the target of a reset,
the initiator of an approval); every `isTenantRoleAbove` and the target's active / 404 check move
inside the transaction onto the locked rows (SEC-7).
Errors (typed, mapped in each route's catch arm): not permitted / inactive → `TenantAuthError` →
`handleAuthError` (403); session gone → `UserAuthRevokedError` → `unauthorized()`;
`TenantMemberLockTimeoutError` / `UserAuthLockTimeoutError` / 40P01 / P2028 →
`isMembershipLockConflict` → `membershipConflictResponse` (409). The tenant-row budget and the
credential lock's own budget (3 s each) can together pass Prisma's 5 s transaction timeout: that
surfaces as P2028, also 409, accepted (F4-r5). Reset approve's initiator refusal
reuses `RESET_NOT_APPROVABLE` (409), not a cause-revealing code.

| Site | Writes | Permission / alsoLock | Limiter keys cleared on a C5 refusal |
|---|---|---|---|
| `POST /api/tenant/service-accounts/[id]/tokens` | SA token | `SERVICE_ACCOUNT_MANAGE` | none (no limiter) |
| `POST /api/tenant/access-requests/[id]/approve` | SA token (JIT) | its permission | none (the key is tenant-wide; never cleared) |
| `POST /api/tenant/members/[userId]/reset-vault` | reset | `MEMBER_VAULT_RESET`; `[targetUserId]` | `rl:admin-reset:target:<target>` only (max 1: a request that passed it found it empty, so clearing restores the prior state) |
| `POST .../reset-vault/[resetId]/approve` | reset approval | `MEMBER_VAULT_RESET`; `[initiatedById, targetUserId]`; the CAS also requires the initiator's locked row active with `MEMBER_VAULT_RESET` and not `departedSince(row, reset.createdAt)` | none (the per-target key is shared, max 5; clearing would wipe other admins' counts — SEC-13) |
| `POST /api/tenant/webhooks` | tenant webhook | `WEBHOOK_MANAGE` | none |
| `POST /api/tenant/scim-tokens` | SCIM token | `SCIM_MANAGE` | none |
| `POST /api/tenant/mcp-clients` | MCP client | `SERVICE_ACCOUNT_MANAGE` | none |
| `POST /api/tenant/service-accounts` | service account | `SERVICE_ACCOUNT_MANAGE` | none |
| `PUT /api/tenant/service-accounts/[id]`, `PUT /api/tenant/mcp-clients/[id]` | re-activation (undoes containment) | `SERVICE_ACCOUNT_MANAGE`, called in the write transaction when `data.isActive === true` | none |
| `POST /api/mcp/authorize/consent` (DCR claim arm only: sets `tenantId`, `createdById`) | MCP client | `null`; tenant = `userTenantId` (the claim's own `resolveOwningTenantIdFromClient` id); gate inside the claim callback before its `advisoryXactLock(tx, userTenantId)`; `MCP_CLIENT_CONSENT` gains `tenantMember`, `tenantMemberDeparture`, `session` (it runs under bypass, not tenant RLS) | none |
| `POST /api/tenant/breakglass` | break-glass grant | `BREAKGLASS_REQUEST` | none |
| `POST /api/emergency-access` | emergency-access grant (already inside `withUserTenantRls`; the gate is that callback's first statement, on its `tenantId` — the id the grant is written under, by construction) | `null` | none |

The member set is a CLASS, enforced default-deny by C10 (SEC-12, F1-r5, F2-r5, F1-r6):
- Models: the containable models come from one map in `member-containment.ts`
  (`FOOTHOLD_MODEL: Record<FootholdKind, PrismaModelName>`); C10 also requires every schema model
  with a `tenantId` and a relation field to `User` other than its own subject `userId` (derived from
  the parsed schema, not a column-name list — F1-r7-sec) to be in that map or in a keyed "not
  containable" list citing its reason or SC id (seeded: operator tokens — subject-bound; team
  invitations / team webhooks — team domain, `#1043`; access requests — token goes to the approver;
  master-key rotation — operator; password shares — SC2; …), so SC1/SC2 must touch both (F2-r6).
- Sites: EVERY call of a write method (`create`, `createMany`, `createManyAndReturn`, `upsert`,
  `update`, `updateMany`, `updateManyAndReturn`) on those delegates, whatever `data` holds, is a
  site, including the write inside a wrapper (`transition` in `emergency-access-state.ts` is keyed at
  its own write, and a wrapper taking the delegate as a parameter is refused as aliased — F2-r7-sec). Each site either calls `lockFootholdWriter` in its function or is an
  exempt key with a reason. Nested relation writes to these models, aliased / destructured /
  computed delegates (`tx[model]`), and lexed raw `INSERT` / `UPDATE` / `DELETE` naming their tables
  (or a templated table slot) in `src/` are refused as unclassified (an undecidable spelling is
  refused, not guessed); raw reads stay with the delivery-reader rule (F1-r7). `scripts/` and
  `prisma/` are out of the writer scope: they run with an operator's authority, not a member's
  session (F3-r7-sec).
- Exempt keys (reason per key): writes that only revoke, deactivate, expire or count (revoke routes,
  C4, C7, reapers, `lastUsedAt` / health); the target-driven execute of an approved reset; the DCR
  registration (no tenant, no creator); the bootstrap migration's `tenantId` moves (sole OWNER, not a
  member foothold — F3-r6); `transition()`'s forward moves (the caller acts through its own session,
  and the CAS `from` states refuse a revoked grant).
`permission: TenantPermission | null` — `null` skips the role test but still requires a present,
active row (F3-r6).
Per-site error mapping (F2-r6): tenant routes add catch arms (`TenantAuthError` → `handleAuthError`,
`UserAuthRevokedError` → `unauthorized()`, lock conflicts → 409, ahead of any `P2002` arm); the
emergency-access POST gains a catch with the same arms; the consent route maps not-permitted /
inactive to its existing `access_denied` 403, a revoked session to `unauthorized()`, a lock conflict
to a JSON 409, none swallowed by its `P2002` arm.
`computeApproveEligibility` gains the initiator verdict (F6-r2).

What it orders (stated precisely, SEC-8): against a departure or demotion — the writer holding FOR
SHARE commits first (C4's later statement in the departure sees the row) or waits and reads the
committed state; against containment — a write either commits before containment takes the
credential lock, or waits and finds its session revoked. A row committed before containment but
after the admin's listing is not in the admin's selection: C7's `remaining` count shows it.

The bootstrap-tenant migration (`src/auth.ts`) takes the credential lock and later deletes the
user's bootstrap tenant row; it gains `lockTenantRows(tx, existingTenantId, [userId], "update")`
before its `lockUserAuthArtifacts`, so its order is tenant row → credential lock like every
departure writer (F1-r3). Its grant `AUTH_TENANT_CLAIM_MEMBERSHIP` gains `tenantMemberDeparture`, so
the departure read inside `lockTenantRows` is not silently empty (F1-r4). Default lock budget; a
timeout or 40P01 throws into the sign-in callback's existing catch → `provider_error`, retryable
like its other lock conflicts (F3-r5).

### C6 — Creator flags (K2, K3, and pre-upgrade K1 residue)
`creatorAuthorized: boolean | null` from C2 on: SCIM-token GET (`SCIM_MANAGE`; select `createdById`;
the response is a bare array, field per element), MCP-client GET (`SERVICE_ACCOUNT_MANAGE`; null for
`isDcr` clients — a claimed DCR client's `createdById` is any member who claimed it), SA-token GET
(`SERVICE_ACCOUNT_MANAGE`). Consumers render a one-line note for `false` (en/ja):
`team-scim-token-manager.tsx` (namespace `Team`), `mcp-client-card.tsx` (`MachineIdentity`), the
SA token list component (namespace of its card).

### C7 — Containment entries (K4, K6)
- `FOOTHOLD_KIND` gains `TENANT_WEBHOOKS: "tenantWebhooks"` (`WEBHOOK_MANAGE`) and `VAULT_RESETS:
  "vaultResets"` (`MEMBER_VAULT_RESET`), before emergency-access grants (kept last; dialog order =
  write order).
- Live predicates: webhook `{ tenantId, createdById: member }`; reset as C4 with `initiatedById:
  member`.
- Listing: webhooks `{ id, url, isActive, createdAt }`; resets `{ id, targetUserId, targetUser:
  { name, email }, createdAt, expiresAt }` (LIST grant gains `user`).
- Writes: webhooks — read on the predicate, `deleteMany` on the read ids + predicate, count must
  equal (else throw, rolling back — the accounts step's rule); one `TENANT_WEBHOOK_DELETE` per row
  (`metadata: { webhookId, url: maskUrlForDisplay(url), targetUserId: member }`). Resets — as C4,
  `ADMIN_VAULT_RESET_REVOKE` with `metadata: { resetId, initiatedById: member, revokedById: actor }`.
- Remaining (SEC-8; F2-r5-sec, F5-r5): after the writes, still under the credential lock,
  `containMemberInTx` counts, per kind the actor may contain, the member's live rows it did not
  write, and returns `remaining: Partial<Record<FootholdKind, number>>`; the dialog's toast says
  "N live footholds of this member remain" when any is non-zero — no timestamp baseline, so no skew
  and no claim-time gap; it counts deliberately unselected rows too, and says so. Absent when the
  request carried no containment; the field and client type sit beside `ContainedCounts`.
- Body keys `tenantWebhookIds`, `vaultResetIds` (strict schema); grants `TENANT_MEMBER_PASSKEY_LIST`
  gains `tenantWebhook`, `adminVaultReset`, `user`; `_REVOKE` gains `tenantWebhook`,
  `adminVaultReset`.
- Consumer: `tenant-member-passkeys-dialog.tsx` reads `createdFootholds.tenantWebhooks[] { id, url,
  createdAt }` (label url, detail created) and `.vaultResets[] { id, targetUser, expiresAt }` (label
  target name/email, detail expiry) and sends chosen ids as `revoke.tenantWebhookIds` /
  `revoke.vaultResetIds`.

### C8 — Access log of a team link (K8)
`shareLinkManagerOf(userId, share, req, { requireMembership?: boolean })`: with the option, a team
link's creator is `CREATOR` only when `getTeamMembership(userId, teamId)` (leftover-aware, no second
IP evaluation) returns a row; else null (→ 404). The access-logs route passes it; revoke does not.
`/api/share-links/mine` needs no change: team links appear there only in team context, behind
`requireTeamMember`.

### C9 — Docs and follow-up
Webhook / audit-log docs mention the pause and the departure revocations; a release note for the
upgrade-time pausing of webhooks whose backfilled creator has left; follow-up issue for SC1–SC3.

### C10 — Member-set gates
- `src/__tests__/foothold-member-set.test.ts` (ts-morph, no Program), per CALL SITE with its
  enclosing function, never per file (T-G):
  - delivery readers: every `tenantWebhook.` / `teamWebhook.` `find*` call and raw `FROM
    tenant_webhooks|team_webhooks` (SQL lexed with the repo's existing lexer helper, not a regex) in
    `src/`, `scripts/`; each site is keyed and classified — delivery (its function must call
    `creatorVerdicts` / `webhookCreatorVerdicts`), management or claim-carry (reason given; the
    `webhook_deliveries` claim carries already-resolved webhooks). An unclassified or stale key fails.
  - foothold writers: the C5 class predicate, default-deny (C5 "The member set is a CLASS"): the
    model map / schema-column check, every write method and named wrapper as a site, refused
    spellings; positive-control fixtures for each spelling (nested write, destructured delegate,
    computed delegate, raw SQL, wrapper call, spread `data`).
  - raw SQL whose table slot is templated (`${sqlTable(...)}`) is unclassified unless its site is keyed
    with a reason (SEC-9).
  - position: `lockFootholdWriter` must precede any `advisoryXactLock` and any write in the same
    transaction callback (F5-r3).
  - positive controls: a fixture tree with a classified site passes, an unclassified one fails, an
    exemption without a reason fails. Red-proved on a scratch copy.
- `scripts/checks/check-team-rotation-input-lock.mjs` rule 9 (membership ends): a second required
  callee, `endCreatorFootholdsInTx`, must follow the revoker call in source order in the innermost
  function (the lock-order claim), with its own exemption prefix `foothold-end::` (only
  `src/auth.ts`'s bootstrap migration, reason recorded) so no other family's exemption satisfies it
  (F3-r2). Self-test: missing call, wrong order, foreign exemption, the call in a different branch from the
  revoker (the `deactivateScimUser` shape) — each red; the pin count updated (T3-5).

## Forbidden patterns
- `pattern: from "@/lib/auth/access/tenant-auth"` in `src/lib/tenant/creator-authority.ts`,
  `src/lib/auth/access/tenant-permissions.ts`, `src/workers/` — reason: loads `@/lib/prisma` in the
  worker (also caught by `scripts/checks/check-worker-bundle-smoke.sh`).

## Acceptance criteria
Race cells use `race-helpers.ts` (`holdPrismaWriter`, `pg_blocking_pids`-based
`waitForBackendBlockedBy`): the waiter is proven blocked BY the held pid before release (RT4), and
the held transaction runs the production function, not a stand-in lock (T-A).
- `departed-member-leaked-authority.integration.test.ts` (tenant cells beside the team C6 suite):
  worker `resolveWebhookSubscribers` skips a tenant webhook whose creator departed / was demoted /
  was SCIM-deleted and re-created, delivers a legacy one and a current admin's; the real
  `dispatchTenantWebhook` read under its grant, same three cases, as `passwd_app` (T-C); backfill
  cells (the migration's block carries one `-- BEGIN BACKFILL tenant-webhook-creator` / `-- END
  BACKFILL tenant-webhook-creator` pair for `readBackfillBlock`; T4-3): latest event wins, HUMAN+TENANT only, same tenant, outbox fallback, NULL when none — the
  migration's `DO` block run in a transaction as a NOBYPASSRLS role, so it cannot pass as superuser
  (T3-7).
- New `member-foothold-departure.integration.test.ts`:
  - `departFromTenant`, `deactivateScimUser`, `departCreatedMembership`, `returnToTenant` each revoke
    the user's live SA token and pending reset and write the audit rows; another admin's token, an
    approved reset, an expired token stay (one cell per writer — the red-proof of each writer's call).
  - Every route-calling cell seeds a `sessions` row for the actor and sends its cookie through a
    shared helper (`db-integration/session-request.ts`, after `sessionCookieRequest` / `postAs` in
    `user-auth-serialization.integration.test.ts`) (T4-2).
  - Departure race (T3-1): `holdPrismaWriter(su, tx => departFromTenant(tx, …), timeout well above
    the 3 s lock budget)` holds the real departure; the routes are called as real handlers;
    `waitForBackendBlockedBy(writer.pid)` observes each blocked, then `release()` immediately (T4-3).
    SA-token mint: the departing user is the actor (an ADMIN — `departFromTenant` never departs an
    OWNER) → 403, no token. Reset approve: the departing user is the initiator → 409
    `RESET_NOT_APPROVABLE`, `approvedAt` unwritten; C4 also revoked the reset, so here the
    pre-release blocked observation is what discriminates C5. The reverse order (mint committed
    first, then departure) is covered by the sequential cell above, not a held route (a route owns
    its transaction and cannot be paused past its insert).
  - Containment fence: `holdPrismaWriter(su, tx => revokeUsersAuthArtifactsInTx(tx, [actor], …))`
    (the production primitive containment runs under the credential lock); the mint route observed
    blocked by it; release; 401 and no token.
  - Gate cells on real rows, one table-driven file (`foothold-write-gate.integration.test.ts`) over
    EVERY C5 site; each row carries `{ seed, buildRequest, assertNoWrite, heldChange: "demotion" |
    "deactivation" }` — deactivation for the `permission: null` rows (consent, emergency-access),
    where a demotion cannot discriminate (T7-1, F2-r7) (the consent row: form
    POST with PKCE / redirect / Origin, a seeded DCR client, `assertNoWrite` = `tenant_id` and
    `created_by_id` stay NULL), fresh users per cell (F2-r6, F4-r6):
    - held demotion / deactivation: `holdPrismaWriter` holds an uncommitted `UPDATE tenant_members`;
      the route's pre-check reads the committed state and passes; the route is observed blocked on
      the held pid; release → 403 (consent: `access_denied`) and no write. This is the cell that
      fails when the gate is removed (F1-r6); a sequential demotion cell is kept only as a labelled
      pre-check control.
    - session row deleted → 401 and no write; allow → the write commits; the reset routes add
      `alsoLock` target / initiator held-departed → refuse; the two PUT rows add `isActive: false`
      under the same held change → 200 without blocking (the revoke stays ungated — T7-2).
    Limiter-clear claims are asserted in the unit route cells (the file's limiter is mocked).
  - Approve with a departed / demoted initiator → 409 `RESET_NOT_APPROVABLE`, `approvedAt`
    unwritten; current initiator → 200.
- `tenant-member-passkey-revoke.integration.test.ts`: containment lists and removes webhooks and
  pending resets (and never selects `tokenHash` / `encryptedToken` / secrets); `remaining` counts a
  foothold created after the listing; containment and `departFromTenant` of the same member run
  concurrently complete without 40P01 under the real order (T3-2: this cell is not the order proof —
  rule 9's ordered-callee check is).
- Unit: `tenant-permissions.test.ts` (+ `tenant-auth` re-export pin); `creator-authority.test.ts`
  (truth table incl. departure record, after `webhook-creator-authority.test.ts`);
  `foothold-write-gate.test.ts`; route cells (403 / 401 / 409 / limiter cleared / allow); C6 route +
  component cells (true / false / null; DCR null) incl. `service-account-card` (namespace
  `MachineIdentity`); C7 validation, listing, writes, dialog; C8 manager option cells and the
  access-logs route; `team-departure.test.ts` (helper called after the revoke with the transitioned
  users, from all three); `scim-user-service` (DELETE calls it after the revoke).
- Red-proofs on scratch copies, one mutation each, the named test must fail (T-D): drop the C4 call
  from one writer; drop C2's departure clause; revert C8's option; remove the C3 skip in each reader;
  remove `lockFootholdWriter` from each C5 site (its table-driven row fails; SA mint and approve also
  fail their race cells); move C4 before the revoke (rule 9).
- Static: `check-bypass-rls`, `db-grants-manifest.json` / `audit-db-grants` (no diff expected),
  `check-rls-grant-evidence`, `check-team-rotation-input-lock` (+ self-test), C10 test,
  `check-worker-bundle-smoke.sh`, i18n key coverage.

## Testing strategy
Existing tests reaching the C5 routes (derived from imports of the route modules: `rg -l "tenant/(service-accounts|access-requests|members/\[userId\]/reset-vault|webhooks|scim-tokens|mcp-clients)" src/__tests__ src/app`)
are updated, not mocked around: real-DB ones (e.g. `access-request-approve-scope-dedup.integration.test.ts`,
`tenant-member-passkey-revoke.integration.test.ts`)
seed a session and send the cookie via the shared helper; prisma-mocked ones (e.g.
`src/__tests__/integration/jit-workflow.test.ts`, `sa-lifecycle.test.ts`) mock `foothold-write-gate`
in the test file and keep a gate-call assertion (T4-1).
Unit tests beside each changed module; existing tests extended: `webhook-dispatcher.test.ts`,
`audit-outbox-worker.test.ts`, tenant webhooks / SCIM-token / MCP-client / SA-token / reset-vault
initiate+approve / access-request approve / service-account token route tests,
`base-webhook-card` / tenant webhook card / SCIM manager / MCP card tests, `member-containment.test.ts`,
`tenant-member-passkeys-dialog.test.tsx`, `team-departure.test.ts` (helper mocked: called after the
revoke with the transitioned users, from all three), `scim-user-service` tests, share-link-manager
and access-logs tests. Full `vitest`, `test:integration`, `next build`.

## Considerations & constraints
- Integrations on a token a departed admin minted stop; an admin re-mints (audited).
- Legacy NULL-creator SA tokens and webhooks are not attributable and keep working; webhooks created
  by pods still running the old code during the rollout window are NULL too (SF7).
- Backfilled webhooks whose creator already left pause on upgrade (release note).
- A demotion does not revoke K1/K6 (role churn would break integrations): C5 refuses new mints and
  approvals, C6 flags the tokens, approve refuses a demoted initiator's reset, containment removes
  them.
- A creator deactivated and returned regains webhook delivery (live check); one hard-deleted and
  re-created does not (departure record).
- Files: `prisma/schema.prisma`, `foothold-write-gate.ts`, `admin-reset-eligibility.ts`, `foothold-member-set.test.ts`, new migration, `tenant-permissions.ts`, `tenant-auth.ts`,
  `creator-authority.ts`, `departure-footholds.ts`, `team-departure.ts`, `scim-user-service.ts`,
  `scim/v2/Users/[id]/route.ts`, worker, `webhook-dispatcher.ts`, `tenant-rls-grants.ts`, tenant
  webhooks route, SCIM-token / MCP-client / SA-token GET routes, the four C5 routes,
  `member-containment.ts`, `validations/member-containment.ts`, the dialog, `share-link-manager.ts`,
  access-logs route, the C6 components, `messages/{en,ja}/{TenantWebhook,Team,MachineIdentity,TenantAdmin}.json`
  (+ the SA token card's namespace), `check-team-rotation-input-lock.mjs`, docs.

- Directory sync's multi-call transaction holds earlier users' C4 rows while taking a later user's
  credential lock; containment of that later user deactivating a service account whose tokens an
  earlier user minted can deadlock with it (SEC-3); a C5 writer (FOR SHARE on a later user's row,
  waiting on that user's credential lock) and approve's multi-user lock join the same class
  (SEC-11, F7-r3). Postgres aborts one side (40P01): availability only — C5 routes answer 409, the
  sync run retries next interval, containment answers an error and is retried.
- The bootstrap-tenant migration (exempt from C4) leaves the abandoned bootstrap tenant's SA tokens
  and webhooks, minted by its sole OWNER, live: that user still owns them (F4-r2).
- SCIM-token, MCP-client and service-account POSTs are gated by C5 against containment and
  departure, but their kinds stay flag-only on departure (SC4).

### Scope contract
- SC1: K5 audit delivery targets (creator column + containment) — follow-up issue.
- SC2: K7 personal share links and Sends in containment — follow-up issue.
- SC3: K9 actor filter / activity view on tenant audit logs — follow-up issue.
- SC4: K2/K3 auto action — decided against (owner).

## User operation scenarios
1. An admin who created a webhook to an external endpoint is deprovisioned by SCIM (DELETE or
   `active=false`): the webhook stops delivering and shows "paused"; their SA token is revoked; a
   reset they initiated against another member is revoked before anyone approves it.
2. An OWNER contains a compromised ADMIN: the dialog lists the webhook and pending reset alongside
   the existing kinds.
3. The SCIM token's minter leaves: provisioning continues; the token list says its creator no longer
   has access, so an admin rotates it.

## Implementation Checklist
- C1 `src/lib/auth/access/tenant-permissions.ts`, `tenant-auth.ts` re-export.
- C2 `src/lib/tenant/creator-authority.ts` (reuses `readTenantRows`, `departedSince`).
- C3 schema + `20261116300100_tenant_webhook_creator`, tenant webhooks route, worker tenant branch, `webhook-dispatcher.ts`, `TENANT_WEBHOOK_DISPATCH`, `TenantWebhook.json`.
- C4 `src/lib/tenant/departure-footholds.ts`; `team-departure.ts` (3 writers), `scim-user-service.ts` + SCIM Users/[id] DELETE.
- C5 `src/lib/tenant/foothold-write-gate.ts` at the 13 sites of the C5 table; `auth.ts` bootstrap lock; `MCP_CLIENT_CONSENT`, `AUTH_TENANT_CLAIM_MEMBERSHIP`; `admin-reset-eligibility.ts`; `footholdWriteErrorResponse`.
- C6 SCIM-token / MCP-client / SA-token GETs and their three components; `Team.json`, `MachineIdentity.json`.
- C7 `member-containment.ts`, validation, `member-passkey-revoke.ts`, dialog, `TENANT_MEMBER_PASSKEY_LIST/REVOKE`, `TenantAdmin.json`.
- C8 `share-link-manager.ts`, access-logs route.
- C10 `src/__tests__/foothold-member-set.test.ts`; rule 9 of `check-team-rotation-input-lock.mjs`.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Import-safe tenant permissions | locked |
| C2 | Creator authority helper | locked |
| C3 | Tenant webhook creator + pause | locked |
| C4 | Departure revocation (SA tokens, pending resets) | locked |
| C5 | Mint/initiate serialization | locked |
| C6 | SCIM/MCP creator flags | locked |
| C7 | Containment entries | locked |
| C8 | Team link access log membership | locked |
| C9 | Docs + follow-up issue | locked |
| C10 | Member-set gates (delivery readers, departure writers) | locked |
