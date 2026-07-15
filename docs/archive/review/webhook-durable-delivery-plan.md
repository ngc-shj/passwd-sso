# Plan: Durable, Idempotent, Crash-Safe Tenant/Team Webhook Delivery

## Project context
- Type: `mixed` — Next.js 16 web app + long-running Node workers + Postgres/Prisma + CI
- Test infra: `unit + integration + E2E + CI/CD` (vitest, real-DB integration, Playwright)
- Verification env constraints: VC-DB — real-DB integration requires the dev Postgres
  (running). All contracts `verifiable-local`. No macOS/cosign/container paths.

## Objective
Make tenant/team webhook delivery from the audit-outbox worker **crash-durable** and
**idempotent** (no lost webhook on crash, no duplicate on concurrent same-row
re-delivery, on BOTH the chain and non-chain audit paths). This addresses external
security-review finding EXT-2, whose first fix (the `didInsert` gate) was flawed — it
made loss worse and did not dedup the non-chain path — and has been reverted.

## Ground-truth reconciliation (verified against the repo)
- **GT-1 (fire-and-forget, no persistence)**: `dispatchWebhookForRow`
  (src/workers/audit-outbox-worker.ts:748) calls `void dispatchWebhook`/
  `dispatchTenantWebhook` (src/lib/webhook-dispatcher.ts:258/:346) — in-process fetch
  with in-memory retry (`deliverWithRetry` :114, `RETRY_DELAYS=[1s,5s,25s]` :82). No DB
  queue, no idempotency key. A crash after `audit_outbox → SENT` commit but before the
  fetch loses the webhook permanently (the outbox row is SENT, never re-claimed).
- **GT-2 (two distinct features)**: the audit-log SINK (`audit_delivery_targets` +
  `audit_deliveries`, per-tenant, `kind ∈ {DB,WEBHOOK,SIEM_HEC,S3_OBJECT}`, single
  encrypted config blob, NO per-event `events` filter) is SEPARATE from the tenant/team
  webhook PRODUCT (`tenant_webhooks`/`team_webhooks`, per-webhook `events String[]`
  filter, versioned per-webhook secret AAD, own CRUD APIs). Different config, different
  crypto — must not be merged.
- **GT-3 (non-chain deliverRow ALSO uses ON CONFLICT)**: `deliverRow` (:117) does
  `INSERT INTO audit_logs ... ON CONFLICT (outbox_id) DO NOTHING` (:151) WITHOUT
  `RETURNING id`. The reverted gate's `didInsert=true` literal for the non-chain path
  and its "non-chain has no ON CONFLICT dedup" comment were BOTH factually wrong — the
  non-chain path can double-dispatch on a reaper re-enqueue.
- **GT-4 (audit_deliveries.outbox_id has NO FK to audit_outbox)**: deliberate (migration
  20260415143000) so delivery history survives outbox purge. The new table must follow
  the same no-FK-to-outbox pattern.
- **GT-5 (worker role has no webhook-table grants)**: `passwd_outbox_worker` currently
  has NO privileges on `tenant_webhooks`/`team_webhooks`. Moving delivery into the worker
  loop requires new grants (SELECT for subscriber resolution, UPDATE for health fields).
  Today the fire-and-forget dispatch runs under the app connection via `withBypassRls`,
  not the worker role.

## Design decision: dedicated `webhook_deliveries` queue (option B)
REJECT reusing `audit_deliveries` + an `events` column: it forces a data migration of
tenant/team webhook config into `audit_delivery_targets`, conflates two independently-
configured features, and is crypto-incompatible (versioned per-webhook AAD + dual
Stripe-style HMAC signature vs. single-blob AAD). CHOOSE a dedicated `webhook_deliveries`
work-queue that REUSES the `audit_deliveries` claim/reap/backoff/dead-letter machinery
and the `webhook-dispatcher.ts` delivery primitives, preserving the two-feature
separation with minimal blast radius.

**Events resolution: delivery-time.** Enqueue exactly ONE work item per (outboxId, scope,
teamId) inside the winning audit tx — a cheap single INSERT with a stable dedup key known
entirely from the outbox row (no webhook-table read on the hot path). The delivery worker
later reads the LIVE `tenant_webhooks`/`team_webhooks` whose `events` includes the action
and delivers to each. This matches `fanOutDeliveries` (resolve at fan-out time) and
today's `dispatchTenantWebhook` (resolve subscribers at dispatch time), gives current-
subscription semantics (correct for a notification product), and keeps the `@@unique`
dedup key independent of the webhook set.

## Contracts

### C1 — `WebhookDelivery` model + `WebhookDeliveryScope` enum (schema.prisma near :1197)
- Fields: `id` uuid PK; `outboxId` (`outbox_id`, NO FK to audit_outbox — survives purge,
  GT-4); `tenantId`; `scope` (TENANT/TEAM); `teamId?` (non-null only for TEAM);
  `action` (denormalized for the events filter); `status` (reuse `AuditDeliveryStatus`
  PENDING/PROCESSING/SENT/FAILED); `attemptCount` default 0; `maxAttempts` default 8;
  `nextRetryAt` default now; `processingStartedAt?`; `lastError?` VarChar(1024);
  `createdAt`.
- FK: `tenantId → tenants(id) onDelete Restrict` (no outbox FK).
- `@@unique([outboxId, scope, teamId])` (dedup key); `@@index([tenantId, status,
  nextRetryAt])`, `@@index([status, nextRetryAt])`; `@@map("webhook_deliveries")`.
- Invariant INV-W1 (schema-enforced): ≤1 work item per (outboxId, scope, teamId).

### C2 — Migration `<ts>_add_webhook_deliveries` (template: 20260413100000_add_audit_delivery_targets)
- CreateEnum `WebhookDeliveryScope`; CreateTable `webhook_deliveries`; FK to tenants only;
  the unique index + two indexes; ENABLE + FORCE RLS with the `webhook_deliveries_tenant_isolation`
  policy (identical shape to `audit_deliveries_tenant_isolation`: bypass_rls OR
  tenant_id = app.tenant_id).
- **Timestamp columns are `TIMESTAMPTZ(3)`, NOT the template's `TIMESTAMP(3)`** (P1-review F-func-1).
  The template `20260413100000` was written with `TIMESTAMP(3)`, then a LATER migration
  `20260413120000_convert_timestamp_to_timestamptz` converted every column to `TIMESTAMPTZ(3)`.
  The C1 model declares `@db.Timestamptz(3)` (matching all sibling models). Copying the template
  verbatim would produce a `timestamp without time zone` column → `prisma migrate diff` drift + the
  local-timezone `next_retry_at` comparison bug the 20260413120000 migration exists to fix. Emit
  `TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` for `next_retry_at`/`created_at` and
  `TIMESTAMPTZ(3)` for `processing_started_at`.
- **AlterEnum**: `ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER'` (mirrors
  the template's `ALTER TYPE ... ADD VALUE` for the Phase-3 actions).
- Grants (GT-5): `GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO
  passwd_outbox_worker`; `GRANT SELECT, UPDATE ON tenant_webhooks TO passwd_outbox_worker`;
  `GRANT SELECT, UPDATE ON team_webhooks TO passwd_outbox_worker`.
- Member-set (R14): enqueue needs INSERT; delivery loop needs SELECT/UPDATE/DELETE on
  webhook_deliveries + SELECT on webhook tables (subscriber resolution) + UPDATE on
  webhook tables (health fields failCount/lastError/lastDeliveredAt/isActive).
- **Role attribution (P1-review F-sec-1)**: the enqueue runs under `passwd_outbox_worker`, NOT the
  app role — `processBatch` calls `deliverRow(workerPrisma, ...)` / `deliverRowWithChain(workerPrisma,
  ...)`, and `enqueueWebhookDeliveryInTx` is inside those txns. So the worker INSERT grant above is
  necessary and sufficient; do NOT also grant INSERT on webhook_deliveries to the app role
  (over-privilege). No RLS deadlock: the enqueue runs under `setBypassRlsGucs` (bypass_rls=on), so
  the tenant-isolation WITH CHECK passes on the bypass branch even though the inserted `tenant_id` is
  the real tenant.

### C3 — Enqueue inside the winning audit tx (deliverRow + deliverRowWithChain)
- Shared helper `enqueueWebhookDeliveryInTx(tx, row, payload)`: skip if action ∈
  `OUTBOX_BYPASS_AUDIT_ACTIONS` or `WEBHOOK_DISPATCH_SUPPRESS` (mirror
  dispatchWebhookForRow :752-757); for TEAM+teamId insert a TEAM work item, for TENANT
  insert a TENANT work item, PERSONAL enqueues nothing (matches current dispatch). Uses
  `ON CONFLICT (outbox_id, scope, team_id) DO NOTHING` (defense-in-depth against a reaper
  double-claim; the loser's tx never reaches it).
- `deliverRowWithChain` (:202): call the helper inside the existing `if (inserted.length
  > 0)` branch (:343), same `tx`.
- `deliverRow` (:117): **add `RETURNING id`** to its ON CONFLICT INSERT (GT-3 fix),
  capture `inserted`, change return type to `{ inserted: boolean }`, and call the helper
  inside the tx only when `inserted`. Consumer walkthrough (P1-review F-func-2 — corrected line +
  snippet): the sole non-chain consumer is `processBatch` at **:1157-1159** (`await
  deliverRow(...); rowDelivered = true;`). The ONLY change there is to capture the return —
  `const res = await deliverRow(...); rowDelivered = true;` — leaving `rowDelivered`
  **unconditionally true** (deliverRow always marks the outbox row SENT and never returns a
  paused/skip state, unlike deliverRowWithChain). Do NOT wire `rowDelivered` to `res.inserted`; the
  `inserted` gate lives INSIDE deliverRow's tx (guarding the enqueue), not in processBatch. `res` is
  captured only so a future reader sees the discriminator; the log after the call stays unconditional.
  **[Post-impl update, review round 3]** the audit-delivery fan-out is no longer a post-commit
  `fanOutDeliveries` call after `deliverRow`/`deliverRowWithChain`; it moved INTO the winning tx as
  `enqueueAuditDeliveriesInTx` (gated on the same `inserted` discriminator), matching the webhook
  enqueue. `processBatch` has no post-call fan-out anymore.
- INV-W2 (app-enforced + schema-backed): the enqueue commits atomically with the
  `audit_logs` INSERT; only the ON CONFLICT winner enqueues. Crash before commit rolls
  back both; crash after commit leaves a durable PENDING row.

### C4 — Delivery worker `processWebhookDeliveryBatch` + reaper + purge
- `processWebhookDeliveryBatch(prisma, batchSize)` (sibling of `processDeliveryBatch`
  :535): claim PENDING `webhook_deliveries` with `next_retry_at <= now()` via
  `UPDATE ... WHERE id IN (SELECT id ... ORDER BY next_retry_at ASC LIMIT $n FOR UPDATE
  SKIP LOCKED)` (bounded — must pass the C5 sweep guard); per work item resolve
  subscribers (TENANT: `tenantWebhook.findMany({tenantId, isActive, events:{has:action}})`;
  TEAM: `teamWebhook.findMany({teamId, ...})`) under `setBypassRlsGucs`; fetch the outbox
  payload (if purged, mark SENT + log — event predates retention); deliver via the
  extracted webhook-dispatcher core; mark SENT on pass completion. When mapping live webhook rows to
  `WebhookRecord`, TenantWebhook rows MUST pass `teamId: undefined` (not `null`) to keep the AAD
  byte-identical to the current dispatcher path (webhook-dispatcher.ts:189) — AAD is a distributed
  contract across app/extension/iOS (P1-review F-sec crypto note).
- Reuse webhook-dispatcher primitives: extract/export a pure `deliverToWebhookRecords`
  (wrapping `dispatchToWebhooks` :235 / `deliverSingleWebhook` :164) that does the
  `secretAadVersion` fail-closed check, `buildWebhookSecretAAD` decrypt, dual HMAC
  signatures, SSRF-pinned `deliverWithRetry`, and the onSuccess/onFailure health-field
  updates + `WEBHOOK_DELIVERY_FAILED`/`TENANT_WEBHOOK_DELIVERY_FAILED` audit events. The
  worker passes onSuccess/onFailure running under the worker prisma + `setBypassRlsGucs`.
  Keep `dispatchTenantWebhook`/`dispatchWebhook` exported (directory-sync still uses them,
  SC-W1).
- `recordWebhookDeliveryError` (model on `recordDeliveryError` :677): DB-backed backoff
  (`computeBackoffMs` + `withFullJitter`) and dead-letter at `maxAttempts` with a new
  `AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER` action (register in AUDIT_ACTION const-object,
  OUTBOX_BYPASS_AUDIT_ACTIONS, WEBHOOK_DISPATCH_SUPPRESS, i18n, action groups, tests —
  R12). Retry scope: the WORK ITEM retries only on infrastructure failure of the fan-out
  pass; individual webhook HTTP failures stay on the per-webhook failCount + in-worker
  deliverWithRetry (preserves current semantics, no re-notify of already-succeeded
  webhooks).
- `reapStuckWebhookDeliveries(prisma, limit)` (copy `reapStuckDeliveries` :867 against
  webhook_deliveries; bounded); wire into `runReaper` (:1024).
- Purge: extend `purgeRetention` with a terminal capped `DELETE FROM webhook_deliveries
  WHERE (status='SENT' AND created_at<$1) OR (status='FAILED' AND created_at<$2)` (bounded,
  passes C5 guard); AND add `webhook_deliveries` to the outbox-purge `NOT EXISTS` guard
  (:938) so an outbox row is not purged while a PENDING/PROCESSING webhook delivery
  references it.
- Loop wiring: in `loop()` after `processDeliveryBatch`, add
  `processWebhookDeliveryBatch`; include its claimed count in the idle-poll check.
- Manifest: the new sweeps (`processWebhookDeliveryBatch` claim, reap, purge) are all
  LIMIT/key-set-bounded → pass the C5 guard with no new exemption.

### C5 — Revert the flawed didInsert gate (already partially done)
- Remove the `didInsert` gate + `if (!didInsert) continue` in `processBatch` (DONE) and
  the false "non-chain has no ON CONFLICT" comment (DONE). `deliverRowWithChain` keeps
  returning `{delivered, inserted}` (C7 race test uses it). The flawed
  webhook-dedup integration test is deleted (DONE).

## Forbidden patterns
- pattern: `dispatchWebhookForRow` — reason: the fire-and-forget dispatch is replaced by
  the durable enqueue + delivery loop; must not remain as a live call in processBatch.
- pattern: `ON CONFLICT \(outbox_id\) DO UPDATE` — reason: dedup stays DO NOTHING.
- pattern: `webhook_deliveries.*FOREIGN KEY.*audit_outbox|references.*audit_outbox` (in the
  migration) — reason: GT-4, no FK to audit_outbox.

## Invariants summary
| ID | Invariant | Enforcement |
|----|-----------|-------------|
| INV-W1 | ≤1 work item per (outboxId, scope, teamId) | schema (@@unique) |
| INV-W2 | Work item enqueued atomically with the winning audit_logs INSERT; only the ON CONFLICT winner enqueues | app (tx + inserted-gate) |
| INV-W3 | A durable PENDING work item survives a crash and is re-run (no lost webhook) | schema (persistent row) + reaper |
| INV-W4 | Dead-letter/reaper events for webhook_deliveries stay unchained (writeDirectAuditLog path or a bypass action), never re-enter the outbox | app + forbidden patterns (INV3 parity) |
| INV-W5 | Every new webhook_deliveries sweep is LIMIT/key-set-bounded | CI (C5 sweep guard) |

## Testing strategy
Integration tests run against the SHARED dev Postgres with a live docker worker — every assertion
MUST be self-scoped by a test-created outbox_id / tenant, never a global `COUNT(*)` sweep or purge
delta (P1-review F-test-2/F-test-5). Contracted tests:

**T-obs (delivery observation — P1-review F-test-1, blocks T-crash/T-events/T-adj).** The delivery
core ends in a real SSRF-pinned `deliverWithRetry` fetch. Success is observed via a local mock HTTP
server (`http.createServer` bound to `127.0.0.1`, per
`audit-anchor-github-release-destination.integration.test.ts:38`, with `global.fetch` override) that
returns 2xx; the test asserts the request body + `X-Webhook-Signature` were received AND the
`webhook_deliveries.status` transitions PENDING→SENT. A fake `https://` URL is NOT acceptable — it
fails delivery and makes "no longer PENDING" pass vacuously on a FAILED row.

**T-crash (crash-durability, INV-W3).** Enqueue via `deliverRow`/`deliverRowWithChain` (commits with
audit_logs), then SEPARATELY run `processWebhookDeliveryBatch` and assert the mock server received
the delivery + status→SENT. No real process crash needed.

**T-dedup (INV-W1 — P1-review F-test-3, non-vacuous).** COUNT=1 alone is vacuous: in a correct race
only the audit_logs ON CONFLICT winner reaches the enqueue, so the enqueue's own
`ON CONFLICT (outbox_id, scope, team_id) DO NOTHING` is untested by a race. Additionally exercise the
enqueue conflict path directly — claim→deliver→reset-to-PENDING (reaper)→deliver again (mirror
`audit-outbox-dedup.integration.test.ts:131`) — and assert the second enqueue conflicts (row count
stays 1). Assert the `{inserted}` discriminator, not only the row count.

**T-nonchain (GT-3 RETURNING fix — P1-review F-test-4).** A dedicated `audit_chain_enabled=false`
twin of T-dedup: assert `deliverRow` returns `.inserted===true` on first delivery / `false` on
reaper re-delivery, and exactly one `webhook_deliveries` row results. Without this a dropped
`RETURNING id` (making `.inserted` always false → non-chain path never enqueues) passes silently.

**T-events (delivery-time semantics — P1-review F-test-8).** subscribed vs. not-subscribed;
enqueue for action X then remove X from `tenant_webhooks.events` (or set `isActive=false`) BEFORE
`processWebhookDeliveryBatch`, asserting ZERO deliveries at the mock server while the work item still
transitions → SENT (event lost its subscription — matches current `dispatchTenantWebhook`).

**T-deadletter/reaper.** dead-letter at maxAttempts emits `AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER` via
the unchained `writeDirectAuditLog` path (assert it does NOT re-enter the outbox); reaper resets a
stuck PROCESSING webhook_deliveries row.

**T-grants (R14 — P1-review F-test-7).** Connect AS `ctx.worker` (passwd_outbox_worker), NOT
`ctx.su`. Positive: INSERT/SELECT/UPDATE/DELETE webhook_deliveries; SELECT + live health-field UPDATE
(failCount/lastError/isActive) on tenant_webhooks/team_webhooks. Negative: worker CANNOT INSERT/DELETE
the webhook tables (C2 grants only SELECT/UPDATE there). Update the exact-privilege-set assertions in
`audit-outbox-worker-role.integration.test.ts` + `-phase3` (add the 3 tables to `allowedTables`).

**T-purge (P1-review F-test-5).** Seed one aged-SENT outbox row + one PENDING webhook_deliveries
referencing it; run `purgeRetention`; assert the outbox row STILL EXISTS by id (NOT-EXISTS guard held
it); flip the delivery to SENT; assert it then purges. Survival-by-id, not count-delta.

**T-adj (fail-closed — P1-review ADJ-1).** Seed a `secretAadVersion=1` webhook row; assert the
worker-role delivery path skips it (fail-closed, no delivery, no spurious success) — a new call path
for the `secretAadVersion<2` gate.

**Unit.** enqueue INSERT issued once in the winning branch; skipped for suppressed actions
(OUTBOX_BYPASS/WEBHOOK_DISPATCH_SUPPRESS) / PERSONAL scope.

**Test infra prerequisite (P1-review F-test-2).** Extend `helpers.ts::deleteTestData` FK-safe:
delete `webhook_deliveries` before `tenant_webhooks`/`team_webhooks` before `teams`/`tenants`.

**R12 coverage (P1-review F-test-6).** `audit-i18n-coverage` / `audit-action-group-coverage` /
`audit.test.ts` scope-group / `audit-bypass-coverage` auto-enforce the new action by construction —
BUT `audit-bypass-coverage.test.ts:63` pins the `OUTBOX_BYPASS_AUDIT_ACTIONS` set + `.size`; that
count MUST be bumped for the new action.

**Regression gate.** existing audit-outbox / audit-delivery / audit-chain suites unchanged-green,
EXCEPT the two exact-privilege-set tests, which are intentionally modified (F-test-2).

## Scope contract
- SC-W1: `directory-sync/engine.ts:215`'s direct `dispatchTenantWebhook` stays
  fire-and-forget — not driven by the outbox worker, no outbox row to enqueue against.
  Out of scope. (`dispatchTenantWebhook` stays exported.)
- SC-W2: no change to `audit_delivery_targets`/`audit_deliveries` (SIEM/S3 sink feature).
- SC-W3: no change to the webhook CRUD APIs or the secret-AAD migration script.
- SC-W4: no receiver-side dedup protocol; per-webhook at-least-once is unchanged.
  Optional `X-Webhook-Delivery-Id: <webhook_deliveries.id>` header for receiver
  idempotency — noted, not required this PR.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | WebhookDelivery model + enum | done |
| C2 | Migration (table/RLS/grants, timestamptz, NULLS NOT DISTINCT, ALTER TYPE) | done |
| C3 | Atomic enqueue in both audit paths + deliverRow RETURNING fix | done |
| C4 | Delivery worker + reaper + purge + dead-letter action | done |
| C5 | Revert flawed didInsert gate | done |

All contracts implemented, migration applied to dev DB, Phase 3 code review converged
(R1: 4 findings W-1/W-2/T-events/INV-W1 fixed + 1 rejected; R2: all fixes verified, no
regression, no boundary widening). 12 integration tests + full unit suite + build + pre-pr
green.

## Implementation Checklist (Phase 2-1)

### C1 — schema.prisma
- Add `enum WebhookDeliveryScope { TENANT TEAM }` near AuditDeliveryStatus (:1099).
- Add `model WebhookDelivery` after AuditDelivery (:1217): all fields `@db.Timestamptz(3)`;
  `@@unique([outboxId, scope, teamId])`; two indexes; `@@map("webhook_deliveries")`; FK
  `tenant → tenants onDelete Restrict`; NO outbox FK.

### C2 — migration `<ts>_add_webhook_deliveries` (dev DB apply via `npm run db:migrate`)
- CreateEnum WebhookDeliveryScope; CreateTable webhook_deliveries with TIMESTAMPTZ(3) columns;
  FK to tenants(Restrict); unique index + 2 indexes; ENABLE+FORCE RLS + `webhook_deliveries_tenant_isolation`
  (satisfies migration-drift invariant A — table has tenant_id).
- `ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER'` (invariant B).
- Grants: `GRANT SELECT,INSERT,UPDATE,DELETE ON webhook_deliveries`, `GRANT SELECT,UPDATE ON
  tenant_webhooks`, `GRANT SELECT,UPDATE ON team_webhooks` TO passwd_outbox_worker.

### C3/C4 — worker (src/workers/audit-outbox-worker.ts)
- `enqueueWebhookDeliveryInTx(tx, row, payload)` helper (skip OUTBOX_BYPASS/WEBHOOK_DISPATCH_SUPPRESS
  + PERSONAL scope; TEAM→teamId item, TENANT→null-team item; `ON CONFLICT (outbox_id,scope,team_id) DO NOTHING`).
- `deliverRow` returns `{inserted: boolean}` (add `RETURNING id`); enqueue inside tx when inserted.
- `deliverRowWithChain` enqueue inside `if (inserted.length>0)` branch (:343).
- processBatch consumer (:1157-1159): `const res = await deliverRow(...); rowDelivered = true;`.
- Remove `void dispatchWebhookForRow(...)` (:1171) + delete `dispatchWebhookForRow` (:748).
- `processWebhookDeliveryBatch` + `reapStuckWebhookDeliveries` + purge extension + outbox-purge
  NOT EXISTS guard (:938) extended to webhook_deliveries; wire into loop() + runReaper().
- `recordWebhookDeliveryError` (dead-letter via writeDirectAuditLog with AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER).

### C4 — delivery core (src/lib/webhook-dispatcher.ts)
- Export `deliverToWebhookRecords` = current `dispatchToWebhooks` (already pure — no prisma/singleton;
  worker injects onSuccess/onFailure closures under its own setBypassRlsGucs). Keep `dispatchWebhook`
  /`dispatchTenantWebhook` exported (directory-sync SC-W1). Keep bypass-rls allowlist entry unchanged
  (worker's raw setBypassRlsGucs is NOT allowlist-gated).

### R12 registration (src/lib/constants/audit/audit.ts) — mirror AUDIT_DELIVERY_DEAD_LETTER
- AUDIT_ACTION const (~:200); AUDIT_ACTION_VALUES array (~:396);
  AUDIT_ACTION_GROUPS_TENANT[MAINTENANCE] (~:750); OUTBOX_BYPASS_AUDIT_ACTIONS (~:868);
  WEBHOOK_DISPATCH_SUPPRESS (~:899).
- i18n: messages/en/AuditLog.json + messages/ja/AuditLog.json (after AUDIT_DELIVERY_DEAD_LETTER :260).
- Tests: audit-bypass-coverage.test.ts:63-64 — bump OUTBOX_BYPASS_AUDIT_ACTIONS expected set (add new)
  + `.size` 7→8. (i18n-coverage / action-group-coverage auto-enforce.)

### Tests (src/__tests__/db-integration/) — mirror existing patterns
- helpers.ts::deleteTestData — add webhook_deliveries (before tenant_webhooks/team_webhooks before teams/tenants).
- audit-outbox-worker-role-phase3.integration.test.ts:62-88 — add webhook_deliveries [D,I,S,U],
  tenant_webhooks [S,U], team_webhooks [S,U] privMap assertions + 3 allowedTables entries.
- New: webhook-delivery-durable.integration.test.ts (T-obs/crash/dedup/nonchain/events/deadletter/purge/adj),
  mock HTTP server per audit-anchor-github-release-destination.integration.test.ts:38.

### CI parity
- pre-pr.sh covers migration-drift / bypass-rls / crypto-domains / team-auth-rls (CI job names differ,
  same checks). No parity gap. migration-drift invariants A/B/C all satisfied by C2.
