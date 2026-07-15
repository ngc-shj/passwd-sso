# Code Review: webhook-durable-delivery
Date: 2026-07-15
Review round: 1

## Changes from Previous Round
Initial code review of the EXT-2 implementation (uncommitted working tree vs main).
Three Opus experts (functionality/security/testing) reviewed the diff incrementally on
top of the Phase 2 self-R-check baseline. Security expert: No findings. Functionality: 1
Major + 1 Minor. Testing: 1 Major + 2 Minor (one rejected).

## Functionality Findings
- **W-1 [Major] — stale `X-Webhook-Timestamp` on delayed/retried delivery.**
  `processOneWebhookDelivery` (audit-outbox-worker.ts:939) used `outbox.created_at` as the
  delivery timestamp, which feeds the Stripe-style `X-Webhook-Timestamp` anti-replay
  signature. Receivers reject deliveries outside a ±5-minute window
  (webhook-dispatcher.ts:137-140). A durable/retried delivery can leave the queue minutes
  to hours after the event, so signing with `created_at` makes every delayed delivery
  replay-stale → silently dropped by a spec-compliant receiver — defeating the durability
  the feature exists to provide. The former fire-and-forget `dispatchWebhookForRow` used
  `new Date()` (dispatch time). **FIXED.**
- **W-2 [Minor] — `retentionPolicyTouched` manifest omits `webhook_deliveries`.**
  `purgeRetention` now also `DELETE FROM webhook_deliveries`, but
  `scripts/checks/worker-policy-manifest.json` listed only audit_outbox + audit_deliveries.
  Doc accuracy (SC3, presence-only CI check). **FIXED.**

## Security Findings
No findings. All 10 focus areas verified clean: AAD byte-identical (teamId undefined/null/
absent all falsy in buildWebhookSecretAAD), RLS enable+force+policy passes bypass WITH
CHECK, tenant isolation (globally-unique teamId + AAD-bound), grants match (not
over-privileged), dead-letter + WEBHOOK_DELIVERY_FAILED unchained via writeDirectAuditLog,
secretAadVersion<2 fail-closed preserved, SSRF pin intact, sanitization present
(sanitizeErrorForStorage/sanitizeForExternalDelivery/maskUrlForDisplay), enqueue INSERT
parameterized, NULLS NOT DISTINCT present.

## Testing Findings
- **T-events-vacuous [Major] — T-events denial path never drives production.**
  Asserted `received.length===0` after isActive=false without ever calling the real
  `processWebhookDeliveryBatch`; used a test-local `resolveTenantWebhookRecords` copy →
  vacuous (RT8). A regression dropping the isActive/events filter in the production
  `resolveWebhookSubscribers` would not be caught. **FIXED** (both sub-cases now drive the
  real `processWebhookDeliveryBatch`; positive asserts a POST, negative asserts zero POSTs
  + SENT via the real path).
- **INV-W1-schema-untested [Minor] — ON CONFLICT/NULLS NOT DISTINCT backstop untested.**
  T-dedup/T-nonchain short-circuit at the audit_logs gate before the 2nd enqueue, so
  dropping NULLS NOT DISTINCT would pass all tests. **FIXED** (direct two-insert test on the
  same (outbox_id, TENANT, NULL) key asserts exactly one row survives).
- **W-1 aged-created_at test gap [Major-adjacent] — no delayed-delivery test.**
  The suite delivered immediately (fresh created_at), so W-1 passed silently. **FIXED**
  (test ages created_at past 5 min, asserts the X-Webhook-Timestamp is fresh dispatch time).

## Rejected Finding
- **reap-webhook-enum-cast [Minor/Adjacent]** — `reapStuckWebhookDeliveries` casts
  `webhook_deliveries.status` to `"AuditDeliveryStatus"`. REJECTED — not a bug:
  `WebhookDelivery.status` IS `AuditDeliveryStatus` by deliberate reuse (C1). The cast is
  correct; the reaper mirrors `reapStuckDeliveries` which does the same. Verified against
  schema.prisma:1240.

## Recurring Issue Check
### Functionality expert
- AAD distributed contract: re-verified byte-identical. R12 completeness: re-verified.
  count_then_create_toctou: N/A (schema-enforced dedup). W-1 is a distributed-contract miss
  (receiver 5-min window) — fixed.
### Security expert
- AAD distributed contract, user-bound/class enumeration, child-model FK scoping,
  count→cap→write TOCTOU: all re-verified clean. []
### Testing expert
- RT1 (mock-reality), RT4 (race non-vacuous), RT8 (denial-path), RT9 (twin), self-scoping:
  re-verified. RT8 gap (T-events) + INV-W1 coverage gap + W-1 test gap found and fixed.

## Environment Verification Report
N/A — all contracts `verifiable-local` (VC-DB: dev Postgres). Integration suite (9 tests)
runs against the real dev DB; grant tests connect AS passwd_outbox_worker. No
blocked-deferred paths.

## Resolution Status
### W-1 [Major] stale X-Webhook-Timestamp
- Action: use `new Date().toISOString()` (dispatch time) for the delivery/signature
  timestamp instead of outbox.created_at; documented why (anti-replay freshness).
- Modified: src/workers/audit-outbox-worker.ts:939

### W-2 [Minor] manifest retentionPolicyTouched
- Action: added `webhook_deliveries` to the audit-outbox-worker entry.
- Modified: scripts/checks/worker-policy-manifest.json:31

### T-events-vacuous [Major] / INV-W1 [Minor] / W-1 test gap [Major-adjacent]
- Action: test fixes (see Testing Findings). Modified:
  src/__tests__/db-integration/webhook-delivery-durable.integration.test.ts

---

## Review round 2 (external re-review after base commit 9ff8e788)

A second external security review of the durable delivery implementation found 5 findings
(2 High, 3 Medium) and marked the branch not-mergeable. All fixed in a follow-up commit.

### R2-F1 [High] — batch-claimed lease expires mid-delivery
`processWebhookDeliveryBatch` claimed up to 500 items (the outbox batch size) into
PROCESSING then processed them serially. An unreachable webhook takes ~36s (3 attempts ×
10s fetch + 6s backoff); ~9 slow items exceed the 5-min PROCESSING timeout, so the reaper
resets still-in-flight rows to PENDING and a second worker re-claims them → duplicate +
concurrent delivery, and a malicious unreachable URL stalls the shared worker.
- **FIXED**: dedicated `WEBHOOK_DELIVERY_BATCH_SIZE` (audit.ts), computed from the timing
  constants so the serial worst case stays under half the PROCESSING lease
  (`floor((TIMEOUT/2 / worstCasePerHook) × CONCURRENCY)` = 20). Fetch timeout + retry delays
  extracted to `WEBHOOK_FETCH_TIMEOUT_MS` / `WEBHOOK_RETRY_DELAYS_MS` (common.server.ts).
  Modified: src/lib/constants/audit/audit.ts, src/lib/validations/common.server.ts,
  src/workers/audit-outbox-worker.ts (loop uses the bounded size).

### R2-F2 [High] — crypto/AAD/DB errors silently marked the work item SENT
`deliverSingleWebhook` swallowed secretAadVersion/key/decrypt failures and onSuccess/
onFailure DB-update throws with a log only; the worker then marked the work item SENT →
a recoverable pending-key-migration or transient DB error **permanently lost** the audit
webhook. The T-adj test had frozen this silent-skip as correct.
- **FIXED**: added an optional `onError(id, err)` callback to `deliverSingleWebhook` /
  `deliverToWebhookRecords` for recoverable (non-HTTP) errors. The worker collects them and
  throws after the pass → `recordWebhookDeliveryError` retries the work item (PENDING +
  backoff) instead of marking SENT. The app fire-and-forget path passes no `onError`
  (unchanged log-and-drop). T-adj rewritten to assert the work item does NOT reach SENT.
  Modified: src/lib/webhook-dispatcher.ts, src/workers/audit-outbox-worker.ts.

### R2-F3 [Medium] — TEAM delivery did not verify tenant ownership
`resolveWebhookSubscribers` filtered `teamWebhook.findMany({ teamId })` without `tenantId`
under bypass RLS, and the schema had no scope/team_id constraint — an inconsistent queue
row could deliver one tenant's audit metadata to another tenant's team webhook.
- **FIXED**: the TEAM query now filters by `{ tenantId, teamId }`; a new migration adds
  `CHECK ((scope='TEAM' AND team_id IS NOT NULL) OR (scope='TENANT' AND team_id IS NULL))`.
  Modified: src/workers/audit-outbox-worker.ts,
  prisma/migrations/20260715001000_webhook_deliveries_review_hardening/migration.sql.

### R2-F4 [Medium] — worker UPDATE grant too broad
`GRANT SELECT, UPDATE ON tenant_webhooks/team_webhooks` let the worker rewrite url, events,
encrypted secret, master_key_version, tenant_id/team_id — far beyond the health fields it
touches.
- **FIXED**: REVOKE the table-wide UPDATE, re-GRANT column-scoped UPDATE on
  (fail_count, last_error, last_failed_at, last_delivered_at, is_active, updated_at). Grant
  tests updated to assert table-level SELECT-only + an exact column-level UPDATE set.
  Modified: the follow-up migration + both worker-role integration tests.

### R2-F5 [Medium] — TEAM failure audit recorded as TENANT scope
`writeDirectAuditLog` always wrote TENANT scope + null team_id, so TEAM webhook failures no
longer appeared in the team audit view (the app dispatcher logged them as TEAM/teamId).
- **FIXED**: `writeDirectAuditLog{,InTx}` gained an optional `{ scope, teamId }`; the audit_logs
  INSERT now carries team_id; `onWebhookDeliveryFailure` passes TEAM scope + teamId for team
  webhooks. Modified: src/workers/audit-outbox-worker.ts.

All R2 fixes verified: typecheck/lint clean, migration applied to dev DB (drift clean),
grant + worker unit + webhook integration suites green.

### Review round 2b — F1 correction (re-review of the R2 fix)

A re-review of the R2 fixes found the F1 batch-size model was **wrong**: the formula
multiplied by `WEBHOOK_CONCURRENCY` (=5) on the assumption that work items processed in
parallel, but the delivery loop was a plain serial `for…await`. `WEBHOOK_CONCURRENCY` only
parallelizes subscribers *within* one work item, not across items — so a batch of 20 would
run serially for 20 × 36s = 720s, far past the 300s lease: the exact lease-expiry the fix was
meant to close.
- **FIXED (genuinely parallel, per user direction)**: `processWebhookDeliveryBatch` now
  processes work items in parallel chunks of a new `WEBHOOK_DELIVERY_CONCURRENCY` (=4,
  distinct from the subscriber-level `WEBHOOK_CONCURRENCY`) via `Promise.allSettled`. The
  batch formula is corrected to `WEBHOOK_DELIVERY_CONCURRENCY × floor(TIMEOUT/2 /
  worstCasePerItem)` so the serial depth `ceil(batch/concurrency) × worstCasePerItem` (=2 ×
  51s = 102s) stays under half the lease. The F1 unit test now checks the real parallel model
  (÷WEBHOOK_DELIVERY_CONCURRENCY, ≤ TIMEOUT/2), and a new integration test proves work items
  run concurrently at runtime (peak in-flight ≥ 2 against a slow mock server — fails if the
  loop regresses to serial). Modified: src/lib/constants/audit/audit.ts,
  src/lib/validations/common.server.ts, src/workers/audit-outbox-worker.ts + tests.

### Review round 2c — consequences of the parallelization

A re-review of the parallelization found 3 more issues, all fixed:
- **[Medium] fail_count lost update** — with items now parallel, concurrent failures for the
  SAME webhook each read the snapshot failCount and wrote the same absolute value → the count
  under-recorded and auto-disable was delayed up to ~4×. FIXED: `onWebhookDeliveryFailure`
  increments atomically in SQL (`fail_count = fail_count + 1`, `is_active` derived from the
  post-increment value via CASE, `RETURNING fail_count`). A concurrency integration test
  asserts `fail_count === N` for N racing failures (mutation-verified: the old absolute write
  fails it).
- **[Medium] lease vs. configurable timeout + unbounded DNS** — `OUTBOX_PROCESSING_TIMEOUT_MS`
  is operator-configurable down to 10s, below the per-item worst case, so the `Math.max(1,…)`
  floor would still claim one item that outlives the lease; AND the per-item worst-case model
  excluded DNS resolution (`resolve4`/`resolve6` have no built-in timeout), so even a "safe"
  timeout hid unbounded slack. FIXED: (a) `resolveAndValidateIps` now bounds each DNS lookup
  with `DNS_RESOLVE_TIMEOUT_MS` (5s) via `Promise.race` (applies to all external-HTTP SSRF
  callers), and `WEBHOOK_WORST_CASE_PER_ITEM_MS` folds the DNS budget in
  (`MAX_RETRIES × (DNS + fetch) + backoffs` = 51s), making the lease bound a real ceiling
  (batch 8, chunks 2, 102s ≤ 150s); (b) `validateWebhookDeliveryLease()` fails the worker
  closed at startup when `TIMEOUT/2 < worstCasePerItem` (a 10s timeout is now rejected).
  Both unit-tested (DNS-hang timeout test with fake timers; guard boundary test).
- **[Low] doc/comment drift** — corrected the concurrency/batch numbers (4/16) in the
  deviation log, this doc, and the runtime-test comment.
- The atomic UPDATE interpolates a code-controlled table name (`isTeam ? "team_webhooks" :
  "tenant_webhooks"`); a `// raw-sql-ident:` marker + `ident-markers=1` in raw-sql-usage.txt
  satisfy the CI raw-SQL guard.

Final round-3 re-review (11 correctness points) confirmed all fixes correct, zero findings.

### Review round 2d — build regression + DNS model correction

A re-review of the DNS/lease work found:
- **[High] production build broken** — folding `DNS_RESOLVE_TIMEOUT_MS` into the lease
  computation made `audit.ts` transitively import `node:dns` (via external-http); `audit.ts`
  is imported by Client Components, so `next build` failed ("chunking context does not support
  external modules: node:dns/promises"). FIXED: moved `WEBHOOK_DELIVERY_BATCH_SIZE`,
  `WEBHOOK_WORST_CASE_PER_ITEM_MS`, `validateWebhookDeliveryLease` to a server-only sibling
  `webhook-delivery-lease.server.ts`; `audit.ts` no longer imports external-http. Build now
  compiles. (Process note: `vitest`/`tsc` do not catch this — only `next build` does; the
  pre-pr Build step is the gate.)
- **[Medium] DNS worst-case halved** — A and AAAA lookups ran serially (each 5s = 10s/attempt)
  but the model counted 5s. FIXED: A/AAAA now run concurrently under ONE 5s deadline, so the
  per-attempt DNS ceiling is genuinely 5s and the 51s per-item model is accurate.
- **[Low] guard not directly tested / [Low] stale =5 comment** — `validateWebhookDeliveryLease`
  is now pure over a `timeoutMs` argument; tests assert the reject/accept boundary directly
  (rejects 10s and just-below-2×worstCase, accepts exactly 2×worstCase). The =5 comment fixed to =4.

### Review round 2e — DNS availability + env-validation guard

- **[Medium] one-family DNS availability** — the parallel DNS form wrapped ONE timeout around
  `Promise.allSettled([resolve4, resolve6])`, so a fast A record was discarded if AAAA hung to
  the deadline (→ `DNS resolution failed`). FIXED: each lookup gets its OWN `withDnsTimeout`,
  then allSettled — total ceiling stays ~5s, a resolved family survives the other's hang, and
  the private-IP check still runs on every collected IP (SSRF intact). Test: `a fast A record is
  USED even when AAAA hangs`.
- **[Low] --validate-env-only bypassed the lease guard** — the guard ran at `worker.start()`,
  but the env-check path exits before start(), so a 10s timeout passed config validation. FIXED:
  the entry script validates the parsed timeout right after Zod parse (before the exit); both
  the env-check and normal startup now reject it. start()'s own guard is kept for programmatic
  callers. Test: `exits 1 with a lease error when OUTBOX_PROCESSING_TIMEOUT_MS is too small`.

### Review round 3 — worker runtime invariants (post-P2 external re-review)

Two Medium findings on the audit-outbox worker, both fixed with regression tests:

- **[Medium] purge audit not attributed per tenant (M1)** — `purgeRetention`'s SENT/FAILED
  branches emitted a single `AUDIT_OUTBOX_RETENTION_PURGED` event attributed to
  `MIN(tenant_id)`, with a `purgedCount` aggregating rows from every tenant in the batch. The
  other tenants got no purge audit, and the chosen tenant's metadata leaked the others' counts
  (a tenant-isolation break). FIXED: both branches now `GROUP BY tenant_id` and write one
  SYSTEM-actor audit row per tenant, each carrying only that tenant's count plus a `branch`
  discriminator ("SENT"/"FAILED"). Test: `attributes purge audit per tenant` (two tenants in one
  batch → each gets exactly one event with only its own count).
- **[Medium] non-DB audit delivery fan-out not durable (M2)** — `fanOutDeliveries` created the
  `audit_deliveries` work rows in a post-commit fire-and-forget tx, so a worker crash in the
  window between the audit commit (outbox already SENT) and the fan-out permanently lost the
  non-DB deliveries (SIEM/S3/webhook targets) — the same durability gap the webhook path already
  closed. FIXED: replaced with `enqueueAuditDeliveriesInTx`, called inside the winning audit tx
  of both `deliverRow` and `deliverRowWithChain` (gated on the audit_logs ON CONFLICT winner),
  `createMany({ skipDuplicates: true })` on the `(outboxId, targetId)` unique key for
  idempotency. Post-commit `fanOutDeliveries` removed. The webhook and audit-delivery enqueues
  are now symmetric (both in-tx, both durable). Tests: `deliverRow enqueues one PENDING
  audit_deliveries row per active non-DB target, atomically with the audit_logs INSERT`; DB-kind
  target enqueues nothing; reaper-style re-delivery (inserted=false) does not double-enqueue.

- **[Nit→fixed] dead-letter / terminal audit was best-effort in a separate post-commit tx** —
  every terminal-transition audit wrote its audit via the own-tx, error-swallowing
  `writeDirectAuditLog` AFTER the state-change tx had committed — so a crash/throw in that window
  could leave a dead-lettered row with no audit trail. FIXED (horizontal sweep of the whole
  class): the TERMINAL/dead-letter events now write via `writeDirectAuditLogInTx` INSIDE the same
  tx as the state change, so the transition and its audit commit atomically (a failed audit rolls
  the transition back and it retries next tick): `recordError` → AUDIT_OUTBOX_DEAD_LETTER,
  `recordDeliveryError` → AUDIT_DELIVERY_DEAD_LETTER, `recordWebhookDeliveryError` →
  AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER, `reapStuckRows` → REAPED/DEAD_LETTER. The now-unused own-tx
  `writeDirectAuditLog` was renamed `writeDirectAuditLogBestEffort` and retained for the ONE
  exception below. All actions are in `OUTBOX_BYPASS_AUDIT_ACTIONS`, so the direct writes never
  re-enter the outbox (no recursion).

### Review round 3b — triangulate three-perspective review of round 3

Security: no findings. Functionality + testing surfaced three real items; all fixed:

- **[Major, functionality] `onWebhookDeliveryFailure` must NOT co-commit its audit.** Co-committing
  the `WEBHOOK_DELIVERY_FAILED` audit with the fail_count increment inverted the fail-safe
  direction for a self-healing availability control: a *deterministic* audit_logs failure would
  roll the increment back on every retry, so a broken webhook would NEVER auto-disable and would
  hammer the endpoint forever. FIXED: the fail_count increment + `is_active` auto-disable commit in
  their own tx (independent), and the audit is written best-effort AFTER via
  `writeDirectAuditLogBestEffort` (warn-on-fail). This is the ONLY sweep site where the state
  change outranks audit atomicity; every terminal/dead-letter event stays co-committed.
- **[Minor→fixed, functionality/class-completeness] the two sibling reapers dead-lettered
  silently.** `reapStuckDeliveries` (audit_deliveries) and `reapStuckWebhookDeliveries`
  (webhook_deliveries) also transition rows to FAILED at max_attempts but emitted NO dead-letter
  audit — members of the same class the sweep addressed. FIXED: both now `RETURNING` the FAILED
  rows and emit `AUDIT_DELIVERY_DEAD_LETTER` / `AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER` in-tx (TEAM
  webhook rows carry TEAM scope + teamId). Regression tests: reaper emits the audit only for rows
  that hit FAILED, plus a fault-injection rollback test on the webhook reaper.
- **[Major→fixed, testing] chain-path M2 enqueue had zero coverage.** The M2 tests exercised only
  `deliverRow` (non-chain). ADDED a `deliverRowWithChain` (chain-enabled tenant) variant asserting
  the same in-tx audit_deliveries enqueue. Also strengthened the M2 idempotency test to isolate
  the `inserted > 0` gate from `createMany({skipDuplicates})` (a target added between the two
  deliver calls must NOT be enqueued by the loser), and added a `recordError`-class rollback
  atomicity test on a second co-commit site.

Non-blocking residuals accepted: the reaper all-or-nothing batch (a poison row rolls back the
whole bounded batch and retries next tick) — audit inputs are machine-generated, so a
deterministic per-row failure is not realistically reachable, and `runReaper` catches the throw so
the worker keeps running (fail-safe, low/low). The global reaper is oldest-first with a global cap
(liveness/fairness, not safety). P2's generic `runWorkerJob`/idempotency-table scaffolding is out
of scope (audit-outbox worker hardening is stage 1).
