# Plan: containment-followups (`#1069`: K5, K7, K9 from `#1032`)

## Project context

- Type: web app (Next.js App Router + Prisma 7 + PostgreSQL 16 with FORCE RLS) plus the
  audit-outbox worker.
- Test infrastructure: unit + real-DB integration + E2E + CI/CD.
- Verification environment constraints: none blocking. This worktree has its own database
  (`passwd_sso_wt_1069`, enforce mode), so integration tests do not race the dev workers. All paths
  `verifiable-local` / `verifiable-CI`. The RDS migrate role (NOSUPERUSER NOBYPASSRLS table owner)
  is reproduced by running the backfill block as such a role in an integration cell.

## Objective

Finish the three kinds `#1032` split off (its plan's SC1–SC3), reusing what `#1070` built: the
foothold write gate (`lockFootholdWriter`) and its default-deny member-set test, the containment
listing / revoke-all path, and the creator-column backfill. Owner decisions (on `#1032`, not
reopened): K5 gets `created_by_id`, a containment entry that deactivates, NO pause on departure;
K7 is listed and revoked by containment (and keeps serving until expiry after a departure); K9 is an
actor filter on the tenant audit-log list and download, linked from the containment dialog.

## Derived facts (commands reproduce each)

- D1 Share writers. Probe: add `passwordShare` (and `auditDeliveryTarget`) to `FOOTHOLD_MODEL`,
  drop `PasswordShare` from `NOT_CONTAINABLE`, run `npx vitest run src/__tests__/foothold-member-set.test.ts`.
  Creating sites: `share-links/route.ts::handlePOST` (personal AND team entries),
  `sends/route.ts::handlePOST`, `sends/file/route.ts::handlePOST`; all three authenticate with
  `auth()` only. No v1 / extension / MCP / bearer route creates a share
  (`grep -rn "passwordShare\.\(create\|upsert\|createMany\)" src` → those three; aliased, computed and
  raw spellings are what the gate itself refuses). Non-creating sites: the revoke
  `share-links/[id]::handleDELETE`, view counting by raw `UPDATE password_shares` in
  `share-links/[id]/content::handleGET`, `s/[token]/download::GET`, `s/[token]/page.tsx::SharePage`,
  operator re-encryption `admin/rotate-master-key/[rotationId]/execute::handlePOST`, the bootstrap
  tenant move `auth.ts::claimedTenantMembership`.
- D2 Delivery-target writers (same probe): `tenant/audit-delivery-targets::handlePOST`,
  `tenant/audit-delivery-targets/[id]::handlePATCH`, worker `processOneDelivery` /
  `recordDeliveryError` (health). No DELETE route (deliveries hold a Restrict FK).
- D3 FK-less uuid columns on tenant models (a python scan of `prisma/schema.prisma`: every
  `String … @db.Uuid` field other than `id` / `tenantId` that no `@relation(fields: […])` names, on a
  model with `tenantId`) — 19 today: `TeamWebhook.createdById`, `TenantWebhook.createdById`,
  `ExtensionToken.familyId`, `McpRefreshToken.familyId`, `TeamPasswordEntry.itemKeyId`,
  `TeamPasswordEntryHistory.itemKeyId`, `Attachment.cekItemKeyId`, `AuditLog.userId`,
  `AuditLog.outboxId`, `AuditDelivery.outboxId`, `WebhookDelivery.outboxId`, `WebhookDelivery.teamId`,
  `AccessRequest.grantedTokenId`, `McpAuthorizationCode.userId` / `.serviceAccountId`,
  `McpAccessToken.userId` / `.serviceAccountId`, `McpRefreshToken.userId` / `.serviceAccountId`.
  `#1070`'s C10 derivation sees only `User` relations, so the two FK-less creator columns (and K5's)
  escape it; TeamWebhook is in no list today.
- D4 Delivery after deactivation. `processDeliveryBatch` claims `audit_deliveries` and delivers with
  `include: { target: true }` without reading `target.isActive`; only fan-out filters. A deactivated
  target keeps receiving its queued backlog (up to 8 attempts). `audit_deliveries` retention is the
  outbox worker's `purgeDeliveryRetentionInTx` (SENT and FAILED only), and `purgeSentAgedInTx` keeps
  any outbox row that still has a PENDING / PROCESSING delivery.
- D5 Tenant audit-log query surfaces: `grep -rln "auditLog\.\(findMany\|findFirst\|count\|groupBy\)" src/app/api`
  → tenant-scoped: `tenant/audit-logs/route.ts`, `tenant/audit-logs/download/route.ts` (others are
  personal, team, break-glass, maintenance). The list honours `scope` / `teamId`; the download
  ignores both although the card's hook sends them to both. Both read only `scope IN (TENANT, TEAM)`;
  `audit_logs.user_id` is the actor id of any actor type (NOT NULL, index `(user_id, scope, created_at)`).
  Both order by `createdAt` alone with an id cursor.
- D6 Team links of a CONTAINED (still present) member keep serving: `share_creator_admitted()`
  refuses only after departure (`#1055`); the K7 decision covered departure.
- D7 Prisma field references work in this stack: `tx.passwordShare.fields.maxViews` inside
  `withTenantRls` in `findMany`, `count` and `updateManyAndReturn` (spike: a tsx script run with
  `.env` loaded, `npx tsx --tsconfig tsconfig.json <script>`, Prisma 7.10.1, output
  `{"a":0,"c":0,"u":0,"hasFields":"object"}`). Whether `check-bypass-rls` accepts the field reference
  as a where value is checked first in Phase 2; if it refuses, the exhausted clause is dropped from
  all three spellings (list, write, count), the exhausted cell becomes "listed and revocable", and a
  deviation is logged (G3).

## Contracts

### C1 — Audit delivery target creator (K5)
- Migration `<ts>_audit_delivery_target_creator`: `audit_delivery_targets.created_by_id UUID` NULL,
  no FK (as `tenant_webhooks`); Prisma `createdById String? @map("created_by_id") @db.Uuid`.
- Backfill in a `-- BEGIN BACKFILL audit-delivery-target-creator` / `-- END BACKFILL …` `DO` block
  modelled on `20261116300100_tenant_webhook_creator`: transaction-local bypass of exactly
  `audit_delivery_targets,audit_logs,audit_outbox`, nil tenant id, previous settings restored.
  Source: latest `AUDIT_DELIVERY_TARGET_CREATE` (scope TENANT, actor HUMAN, same tenant,
  `metadata->>'targetId' = id::text`) in `audit_logs`, else an undrained `audit_outbox` row; the
  outbox arm casts `payload->>'userId'` only when it matches the canonical uuid pattern. None → NULL.
- POST sets `createdById: session.user.id`.
- Grants: none new (table-level grants of `passwd_app` / `passwd_outbox_worker`); `audit-db-grants`
  shows no diff.

### C2 — Foothold model set
- `FOOTHOLD_KIND` gains `SHARE_LINKS: "shareLinks"` → `passwordShare` and
  `AUDIT_DELIVERY_TARGETS: "auditDeliveryTargets"` → `auditDeliveryTarget`, before
  `EMERGENCY_ACCESS_GRANTS` (kept last). `KIND_PERMISSION`: shareLinks `null` (`MEMBER_MANAGE` at the
  route is the gate, as for emergency-access grants), auditDeliveryTargets `AUDIT_DELIVERY_MANAGE`.
- `NOT_CONTAINABLE` drops `PasswordShare`, gains `TeamWebhook` ("team domain: paused at delivery
  once its creator lost team authority, #1043").
- Model-set derivation, name-agnostic (SF2): a tenant model is in the class when it has a
  non-subject `User` relation OR an FK-less uuid scalar (D3's rule). Every FK-less uuid scalar is
  keyed `Model.field` in a new `FK_LESS_UUID` map: `"creator"` (its model must then be in
  `FOOTHOLD_MODEL` or `NOT_CONTAINABLE`) or a reason it is not a user it attributes authority to
  (key ids, outbox ids, rotation families, token subjects, the audit actor). Unkeyed and stale keys
  fail. Boundary (G4): only `@db.Uuid` scalars are candidates — every user reference in this schema
  is a uuid column, and widening to any String would key names, URLs and hashes; a creator column
  declared without `@db.Uuid` would escape, recorded as an accepted boundary.
  Fixtures: an FK-less `createdById` unlisted → refused; a `*ById` that IS an FK, a non-uuid
  String, and a model without `tenantId` → not candidates; a stale key → refused.
- Control class: fail-closed verification gate (the test). Adjudication authority: the parsed
  schema and the ts-morph syntax tree, as in `#1070` C10.
- Writer member set = D1 ∪ D2: gated (C3, C4) or an exempt key with a reason — share revoke; the
  three view-count raw UPDATEs; master-key re-encryption; the bootstrap move; the two worker health
  writes; the two new `containMemberInTx` writes (C5).

### C3 — Gate at share and Send creation (K7 writers)
Each of the three handlers creates in `withUserTenantRls(userId, async (tenantId, tx) => …)` through
`tx` (not the global client), whose FIRST statement is `lockFootholdWriter(tx, req, { tenantId,
actorId: session.user.id, permission: null })` — in `sends/file` before its `advisoryXactLock`. In
`share-links` the gate sits in the one create transaction after the personal / team branch, so
both branches pass it. Errors via `footholdWriteErrorResponse` (403 / 401 / 409). The row's tenant
is the callback's by construction: the preceding entry reads run under the same user-tenant RLS and
the insert's RLS `WITH CHECK` refuses any other. No limiter key is cleared on a refusal. The team
path keeps its pre-transaction team checks (team domain).

### C4 — Gate at delivery-target creation and state change (K5 writers)
- POST: `lockFootholdWriter(tx, req, { tenantId: actor.tenantId, actorId, permission:
  AUDIT_DELIVERY_MANAGE })` first in its `withTenantRls` callback, before `advisoryXactLock`.
- PATCH: order becomes auth → `requireTenantPermission` → step-up → body parse → ONE `withTenantRls`
  transaction: gate (`AUDIT_DELIVERY_MANAGE`, both directions — deactivating a SIEM target removes
  visibility, so it is not a pure narrowing; SF1) → read (404) → no-op answer → update. A step-up or
  parse failure now answers before the 404 (an id's existence is no longer revealed before
  step-up). Response shapes unchanged.

### C5 — Containment entries (K5, K7)
- Live predicates (literals in both `listMemberContainment` and `containMemberInTx` — not a shared
  builder: `check-bypass-rls` reads a where clause only when spelled at the call; held equal by
  `member-containment.test.ts`, whose mock tx carries a sentinel `passwordShare.fields.maxViews`
  that both captured where clauses must contain, N3; the real-DB exhausted cell is the behavioural
  proof):
  - shareLinks: `{ tenantId, createdById: member, revokedAt: null, expiresAt: { gt: now },
    OR: [{ maxViews: null }, { viewCount: { lt: tx.passwordShare.fields.maxViews } }] }` — personal
    links, team links (D6) and Sends (D7).
  - auditDeliveryTargets: `{ tenantId, createdById: member, isActive: true }`.
- Listing: every kind's lister takes at most `MEMBER_CONTAINMENT_MAX_IDS` rows (newest first is not
  required; order stays `createdAt asc`); `moreFootholds: Partial<Record<FootholdKind, number>>`
  carries, per capped kind, the live count beyond the listed rows (FF1); it is a field of
  `MemberContainmentListing` and of the passkeys GET response (`tenant/members/[userId]/passkeys/route.ts`
  copies fields one by one, so it gains the field and a response-shape assertion; G2). shareLinks `{ id,
  shareType, isTeam, createdAt, expiresAt }`; auditDeliveryTargets `{ id, kind, endpoint, createdAt }`
  where `endpoint` is the masked URL or null on decrypt failure, from one helper
  (`src/lib/audit/audit-delivery-target-endpoint.ts`) the settings GET also uses. Never returned:
  `sendName`, `encryptedData`, `tokenHash`, `accessPasswordHash`, file bytes, `configEncrypted`.
- Writes, each `updateManyAndReturn` with an explicit `select` (SF4): shareLinks `{ revokedAt: now }`,
  `select: { id, shareType }`, one `SEND_REVOKE` (TEXT/FILE) or `SHARE_REVOKE` per row, targetType
  `PASSWORD_SHARE`, `metadata: { targetUserId: member, revokedById: actor }`; auditDeliveryTargets
  `{ isActive: false }`, `select: { id, kind }`, one `AUDIT_DELIVERY_TARGET_DEACTIVATE` per row,
  `metadata: { targetId, kind, targetUserId: member }`. Both counted in `remaining`.
- Body keys `shareLinkIds`, `auditDeliveryTargetIds` (strict, max 100).
- Grants: `TENANT_MEMBER_PASSKEY_LIST` and `_REVOKE` gain `passwordShare`, `auditDeliveryTarget`.
- R12 (FF2): `AUDIT_ACTION_GROUPS_TENANT` gains `[SHARE]: [SHARE_REVOKE]` and `[SEND]:
  [SEND_REVOKE]` (TENANT-scope containment rows); the tenant card's `GROUP_LABEL_MAP` gains both;
  `TENANT_WEBHOOK_EVENT_GROUPS` is unchanged (no duplicate, `SEND_REVOKE` stays non-subscribable).
- Copy (FF4/SF3): `containmentScope` (en/ja) stops calling these kinds uncovered and says what
  still is: footholds created before creator tracking (no recorded creator — webhooks and delivery
  targets) and rows in other tenants.
  Dialog: "and N more" per capped kind.
- Consumer walkthrough: `tenant-member-passkeys-dialog.tsx` reads `createdFootholds.shareLinks[]
  { id, shareType, isTeam, expiresAt }` (label = type name: text Send / file Send / entry link /
  team entry link; detail = expiry), `.auditDeliveryTargets[] { id, kind, endpoint, createdAt }`
  (label = endpoint ?? kind; detail = kind + created) and `moreFootholds[kind]`; sends ticked ids as
  `revoke.shareLinkIds` / `revoke.auditDeliveryTargetIds`; `CONTAINMENT_KIND_NAME` gains both.

### C6 — No delivery to a deactivated target (D4, SF1)
`claimDeliveriesInTx` claims only rows whose target is active (`EXISTS (SELECT 1 FROM
audit_delivery_targets t WHERE t.id = d.target_id AND t.is_active)` in the claim CTE). Rows of a
deactivated target stay PENDING, unchanged and unsent; a re-activated target (C4-gated) receives
them on the next claim. The backlog cannot grow while inactive (fan-out skips inactive targets).
Age bound (G1): the worker's retention pass gains `expireInactiveTargetDeliveriesInTx` — PENDING
rows of an inactive target older than the outbox SENT retention window (signature
`expireInactiveTargetDeliveriesInTx(tx, cutoff: Date, limit: number): Promise<number>`, the caller
passing `now − RETENTION_HOURS`, as the sibling `purge*InTx` branches take their cutoffs) move to `FAILED`
(`lastError: "target inactive"`), each with the existing `AUDIT_DELIVERY_DEAD_LETTER` row in the
same transaction (the loss record), bounded per pass like the other retention branches. It runs
in its own transaction under a new grant `OUTBOX_DELIVERY_EXPIRY` = `auditDelivery`,
`auditDeliveryTarget`, `auditLog` (H1: the table is FORCE RLS; the worker role already holds table
SELECT; a dedicated grant rather than widening the shared `OUTBOX_RETENTION_PURGE`, J1), and selects rows by a positive join on `t.is_active =
false` — an unreadable target is never taken as inactive, so a missing grant expires nothing rather
than an active target's backlog; the `check-rls-grant-evidence` baseline and grant tables follow.
Rows are picked in a `WITH picked … FOR UPDATE SKIP LOCKED` CTE and moved by `UPDATE … WHERE status
= 'PENDING' AND id IN picked RETURNING id, tenant_id, target_id`; the pick also takes `FOR SHARE
OF t` on the joined target rows (`FOR UPDATE OF d SKIP LOCKED` on the deliveries), so a concurrent
PATCH re-activation and the pass are ordered: a re-activation holding the target row makes the pass
wait and then re-check `t.is_active` (the row is excluded); a pass holding it makes the
re-activation wait until the expiry has committed (I1/K1); one dead-letter row per returned
row (two overlapping passes → exactly one per delivery). The dead-letter metadata carries
`error: "target inactive"` and the log line its own `_logType: "delivery.expired_inactive_target"`,
so an alert on delivery failure is not paged by a deliberate deactivation (docs say so). So a
parked row never pins its `audit_outbox` payload past retention (`purgeSentAgedInTx` skips outbox
rows with a PENDING delivery), and a re-activation delivers at most that window. Retry-state rows
are PENDING too (`FAILED` is terminal), so the claim's EXISTS covers them. A deactivation committed
after a claim still lets that claimed batch item go out (one batch, accepted). The worker already
holds SELECT and UPDATE on `audit_delivery_targets` (`db-grants-manifest.json`); the claim's EXISTS
needs SELECT and the expiry's `FOR SHARE OF t` needs UPDATE — a grant narrowing to SELECT-only
breaks the expiry, which its real-DB cell catches.
Control class: fail-closed verification gate at the claim; authority: the target row read in the
claim statement.

### C7 — Actor filter, one filter for list and download (K9)
- `audit-query.ts` keeps the parsers: `parseActorUserId(searchParams): { userId?: string } |
  { invalid: true }` (param `userId`, canonical uuid, else 400 `validationError({ userId })`).
- New `src/lib/audit/tenant-audit-filter.ts`: pure `buildTenantAuditWhere({ tenantId, scope, teamId,
  actorType, userId })` and `validateTenantAuditTeam(tx, tenantId, teamId)`; both routes call both.
  The download thereby honours `scope` / `teamId` and gains a 400 for a team outside the tenant
  (FF5). Action and date handling stay per route.
- Ordering gets an id tiebreak in both (`[{ createdAt }, { id }]`, desc / asc) (SF5).
- Authorization unchanged on both (`AUDIT_LOG_VIEW`, `withTenantRls(actor.tenantId)`, `where.tenantId`).
- Download audit row `metadata: { format, actorUserId?, scope?, teamId? }` (filters applied).
- Semantics stated (FF3/SF6): rows whose actor id is the member — the member's own actions and those
  of agents acting as the member — in TENANT and TEAM scope; personal-vault rows are not part of the
  tenant log; a service account's rows carry its own actor.
- Control class of the tenant boundary: enforceable boundary (FORCE RLS + `where.tenantId`); the
  filter is a narrowing.

### C8 — Member activity link (K9 UI)
- `useAuditLogs` gains `initialDateFrom?: string`.
- `TenantAuditLogCard` (`logs`) reads `actor` (uuid, else ignored) and `from` (`YYYY-MM-DD`, else
  ignored) once; `actor` → `userId` in `buildExtraParams`; `from` → initial date. Chip "Actions by
  {name}" (name from a loaded log's `user` with that id, else a generic label) with a clear button
  that drops the filter and the `actor` param (`router.replace`); a one-line note states C7's scope.
- Dialog: `Link` from `@/i18n/navigation` to `/admin/tenant/audit-logs?actor=<userId>&from=<today −
  MEMBER_ACTIVITY_LOOKBACK_DAYS>` (30), `target="_blank" rel="noopener noreferrer"`; no name or
  email in the URL.

### C9 — Docs
`docs/operations/departed-member-access-backfill.md` (the `#1070` section) gains K5/K7/K9, C6 and
the C5 caveats; `docs/operations/audit-log-reference.md`: `SHARE_REVOKE` / `SEND_REVOKE` TENANT-scope
containment rows and metadata, `AUDIT_DELIVERY_TARGET_DEACTIVATE` metadata, the containment kind
list, `AUDIT_LOG_DOWNLOAD` metadata.

## Forbidden patterns
- `pattern: sendName|encryptedData|tokenHash|accessPasswordHash|configEncrypted` in the return
  mappings of `listMemberContainment` / `containMemberInTx` — reason: no secret or member content in
  containment responses.
- `pattern: updateManyAndReturn\(\{[^}]*\}\)` without `select` on passwordShare / auditDeliveryTarget
  in `member-containment.ts` — reason: SF4.
- `pattern: from "@/lib/auth/access/tenant-auth"` in `src/workers/` — reason: worker bundle.

## Acceptance criteria
Every new cell names its red-proof (one mutation on a scratch copy or this worktree's own DB, the
named assertion must fail; TF7):
- Member-set test green; red: gate removed from each of the six C3/C4 sites → unclassified key;
  `FK_LESS_UUID` fixtures as in C2.
- `foothold-write-gate.integration.test.ts` rows (fresh users per cell): share-links personal,
  share-links team, sends, sends/file (`heldChange: "deactivation"`); delivery-target POST, PATCH
  `isActive: true`, PATCH `isActive: false` (`"demotion"`). Each: held change observed blocking,
  then 403 and the DB unchanged (no row / `isActive` as before); session deleted → 401, unchanged;
  allow → written. Red: gate removed per site.
- Backfill cells mirroring the tenant-webhook ones: latest event wins, HUMAN+TENANT only, same
  tenant, non-NULL untouched, second run no-op, outbox fallback with a valid uuid (non-NULL), non-uuid
  outbox `userId` → NULL without abort, none → NULL; NOBYPASSRLS role. Red: drop the uuid guard.
- Containment (`tenant-member-passkey-revoke.integration.test.ts`): the listing returns personal
  link, team link, text Send, file Send and the target of the member, not another member's, not
  revoked / expired (`expiresAt = now`) / exhausted (`viewCount = maxViews`) links, not inactive or
  NULL-creator targets; sentinel values seeded in the forbidden columns are absent from the response
  JSON. Revoke writes and audits the selected rows; ids of another member, another tenant, or
  non-live rows → `skipped`, rows unchanged, no audit row; an unselected row stays live and is in
  `remaining`. 101 live links → 100 listed, `moreFootholds.shareLinks = 1`. Red: drop `createdById`
  from the write predicate.
- Worker (real DB, worker role): a PENDING delivery to an inactive target — fresh and a retry row
  (`attemptCount > 0`), both due (`next_retry_at` in the past) — is not claimed and the deliverer is
  not called; after re-activation the SAME rows are claimed and delivered; expiry cells backdate
  `created_at` relative to the injected cutoff (no wall clock): rows just inside / just outside the
  window, a second pass writing no further dead-letter row, more rows than the per-pass bound
  (only the bound processed); after expiry and re-activation the FAILED rows are not claimed and a
  new event is; an active target's row is claimed. Expiry: an inactive target's row older
  than the window → FAILED + one dead-letter row; a younger one and an active target's old row stay
  PENDING; afterwards the outbox purge removes the formerly pinned outbox row; run as the worker
  role under the real grant (with `auditDeliveryTarget` removed from `OUTBOX_DELIVERY_EXPIRY` on a scratch copy,
  the inactive row stays PENDING and the active one too — the positive-join proof). Unit fixtures set
  `isActive` explicitly. Overlap (`race-helpers.ts`): pass A held open after its pick (rows
  locked), pass B run and observed NOT blocked by A's pid and returning a disjoint set, then A
  released; more eligible rows than A's `limit` are seeded, B's set is non-empty and disjoint from
  A's, their union is every seeded row, exactly one dead-letter row per delivery. Held re-activation:
  `holdPrismaWriter` holds an uncommitted `UPDATE audit_delivery_targets SET is_active = true`; the
  pass is observed waiting on the held pid with `waitForBackendBlockedBy` (bounded poll of
  `pg_locks` / `pg_stat_activity`, no sleep) BEFORE release; released by COMMIT → the target's old
  rows stay PENDING, no dead-letter row; paired variant released by ROLLBACK → the pass expires
  them with one dead-letter row each; red: drop `FOR SHARE OF t` (the pass is not blocked and
  expires them in the COMMIT variant). Red: drop the EXISTS; drop the `is_active`
  predicate from the expiry; replace the positive join with `NOT t.is_active` / a NOT EXISTS
  active form (the grant-removal cell fails); drop `SKIP LOCKED` (B blocks). The UPDATE's
  `status = 'PENDING'` re-check is redundant under the pick's row lock (the pick already filters
  PENDING and holds the rows) and has no distinguishing red-proof; it stays as the claim's idiom.
- PATCH order (route tests): step-up failure on an unknown id → the step-up error, not 404; parse
  failure → 400, not 404; a demoted actor deactivating an already-inactive target → 403 (gate before
  the no-op), DB unchanged. Red: move the gate after the read.
- Cap: 100 live links → no `moreFootholds` key; 101 → `shareLinks: 1` only, while an uncapped kind
  in the same response has no key.
- Further named red-proofs: remove the id tiebreak (paging cell); remove `validateTenantAuditTeam`
  from the download (teamId 400 cell); drop `actorUserId` from the download metadata (metadata
  cell); move the share-links gate into the personal branch only (team-link row).
- Audit-log routes: `userId` narrows both (paired: a same-tenant member's rows returned); invalid →
  400 on both; download honours `scope` / `teamId`, another tenant's team → 400 with no query and no
  download audit row; the download audit row carries the applied filters; integration as
  `passwd_app`: the filter returns this tenant's rows of a member and none of another tenant's; >
  `take` rows sharing one `createdAt` page without skip or duplicate. Red: drop `userId` from the
  shared builder.
- New exports tested: `parseActorUserId`, `buildTenantAuditWhere`, `validateTenantAuditTeam`, the
  endpoint helper (incl. decrypt failure → null; the settings GET test keeps it unmocked).
- R12: tenant groups contain both actions; webhook subscribable list has no duplicate.
- UI: dialog sections, body keys, "N more", link `href` / `target` / `rel` with fake timers; card:
  valid params seed the filter (list and download URLs carry `userId`), invalid ones are ignored,
  the chip clears.
- Fixtures delete in FK order (deliveries before targets) in `afterEach`.
- Static: `check-bypass-rls`, `audit-db-grants` (no diff), `check-rls-grant-evidence`,
  `check-migration-rls-dml`, `check-audit-metadata-narrative`, `check-count-then-create-lock`,
  `check-fail-closed-routes-have-test`, i18n coverage, `check-worker-bundle-smoke.sh`, full `vitest`,
  `test:integration`, `next build`.

## Files
`prisma/schema.prisma`, new migration, `member-containment.ts` (+ test), the passkeys GET route
(+ test), `member-passkey-revoke.ts` (if the result type changes), `validations/member-containment.ts`
(+ test), `tenant-rls-grants.ts`, `foothold-member-set.test.ts`, three share routes, two
delivery-target routes, `audit-delivery-target-endpoint.ts`, `audit-outbox-worker.ts`,
`audit-query.ts`, `tenant-audit-filter.ts`, both tenant audit-log routes, `audit.ts` groups,
`use-audit-logs.ts`, `tenant-audit-log-card.tsx`, `tenant-member-passkeys-dialog.tsx`,
`messages/{en,ja}/{TenantAdmin,AuditLog}.json`, the two docs, their tests, integration files above.

## Considerations & constraints
- Containment also revokes the member's team links (D6); the K7 decision was about departure.
- C6 keeps a deactivated target's backlog for the outbox retention window; a re-activation (gated)
  within it delivers it, older rows are dead-lettered (docs say so).
- Avoid `#1060`'s files: no departure writer is touched.

### Scope contract
- SC1: K5 automatic pause on departure — decided against (owner, `#1032`).
- SC2: K7 revoke on departure — decided against (serve until expiry ≤ 30 days; owner, `#1032`).
- SC3: creator-authority flag on the delivery-target settings list — not part of the K5 decision.

## User operation scenarios
1. An OWNER contains a compromised ADMIN who added a SIEM target to an attacker host and created
   Sends: the dialog lists both; ticking them deactivates the target (its queued backlog is no
   longer claimed) and revokes the Sends.
2. "View this member's activity" opens the tenant audit log filtered to rows the member (or an
   agent acting as them) wrote in tenant and team scope from 30 days ago; the download exports the
   same rows. The member's personal-vault rows are not there.
3. A contained admin's open tab retries "create share link": 401; an admin demoted mid-request
   creating or deactivating a delivery target: 403.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Delivery-target creator column + backfill | locked |
| C2 | Foothold model set (kinds, FK-less derivation) | locked |
| C3 | Gate at share / Send creation | locked |
| C4 | Gate at delivery-target create / state change | locked |
| C5 | Containment entries K5, K7 | locked |
| C6 | Claim excludes inactive targets | locked |
| C7 | Actor filter, shared list/download filter | locked |
| C8 | Member activity link | locked |
| C9 | Docs | locked |
