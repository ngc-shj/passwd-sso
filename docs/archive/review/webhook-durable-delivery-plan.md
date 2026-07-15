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
- Grants (GT-5): `GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO
  passwd_outbox_worker`; `GRANT SELECT, UPDATE ON tenant_webhooks TO passwd_outbox_worker`;
  `GRANT SELECT, UPDATE ON team_webhooks TO passwd_outbox_worker`.
- Member-set (R14): enqueue needs INSERT; delivery loop needs SELECT/UPDATE/DELETE on
  webhook_deliveries + SELECT on webhook tables (subscriber resolution) + UPDATE on
  webhook tables (health fields failCount/lastError/lastDeliveredAt/isActive).

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
  inside the tx only when `inserted`. Consumer walkthrough: `processBatch` (:1132) reads
  the non-chain return — update to `rowDelivered = res.inserted ? true : ...` (the row is
  still marked SENT regardless; `rowDelivered` stays the skip-signal boolean).
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
  extracted webhook-dispatcher core; mark SENT on pass completion.
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
Integration (real DB): crash-durability (enqueue commits with audit_logs; delivery loop
delivers a not-yet-delivered PENDING row); dedup-on-concurrent (race two deliverRowWithChain
→ exactly one work item); BOTH paths (chain + non-chain, non-chain guards the RETURNING
fix); events filter (subscribed vs not, isActive:false skipped, delivery-time semantics);
dead-letter/retry + reaper; grants (worker role can INSERT/SELECT/UPDATE/DELETE
webhook_deliveries, SELECT/UPDATE webhook tables); purge (outbox not purged while a PENDING
webhook delivery references it; terminal rows purged). Unit: enqueue INSERT issued once in
the winning branch, skipped for suppressed actions / PERSONAL scope. Regression gate:
existing audit-outbox / audit-delivery / audit-chain integration suites unchanged-green.

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
| C1 | WebhookDelivery model + enum | pending |
| C2 | Migration (table/RLS/grants) | pending |
| C3 | Atomic enqueue in both audit paths + deliverRow RETURNING fix | pending |
| C4 | Delivery worker + reaper + purge + dead-letter action | pending |
| C5 | Revert flawed didInsert gate | pending |
