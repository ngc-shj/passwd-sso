# Coding Deviation Log: webhook-durable-delivery

Deviations from the contract-locked plan discovered during Phase 2 implementation.

## D1 — Unique index uses `NULLS NOT DISTINCT` (C1/C2 refinement)
**Plan:** `@@unique([outboxId, scope, teamId])`.
**Actual:** the migration's unique index adds `NULLS NOT DISTINCT` (PG15+).
**Why:** TENANT-scope rows have `team_id IS NULL`. Under the default NULLS-DISTINCT
semantics, two `(outbox_id, TENANT, NULL)` tuples are treated as distinct, so the
`ON CONFLICT (outbox_id, scope, team_id) DO NOTHING` defense-in-depth in
`enqueueWebhookDeliveryInTx` would silently insert a duplicate on a hypothetical
re-enqueue. `NULLS NOT DISTINCT` makes the schema-enforced INV-W1 backstop actually
cover the NULL case. Verified: `prisma migrate diff` does NOT flag this as drift vs the
schema's `@@unique` (only a pre-existing `audit_chain_anchors.prev_hash` default diff
appears), so no `migrate dev` friction. The primary dedup remains the `audit_logs`
UNIQUE(outbox_id) gate (only the ON CONFLICT winner reaches enqueue).

## D2 — `@/lib/webhook-dispatcher` imported LAZILY, not at module scope (C4 refinement)
**Plan:** reuse the extracted `deliverToWebhookRecords` from the worker.
**Actual:** the worker imports `{ deliverToWebhookRecords }` via a dynamic
`await import("@/lib/webhook-dispatcher")` inside `processOneWebhookDelivery`, and only
`import type { WebhookRecord }` at module scope.
**Why:** `@/lib/webhook-dispatcher` eagerly imports the `@/lib/prisma` singleton, which
throws at import time when `DATABASE_URL` is unset. An eager import would break the entry
script's `--validate-env-only` path (the Zod env error must surface before any prisma
init) — caught by `scripts/__tests__/audit-outbox-worker-env.test.mjs`. The lazy import
mirrors how the removed `dispatchWebhookForRow` did it. Type-only import is erased at
compile time so it does not pull in the runtime module.

## D3 — `WEBHOOK_AUTO_DISABLE_THRESHOLD` extracted to a shared constant (R2)
**Plan:** silent on the auto-disable threshold.
**Actual:** the hardcoded `10` (`failCount >= 10 ? false : undefined`) in
`webhook-dispatcher.ts` (2 sites) + the new worker `onWebhookDeliveryFailure` site is
now `WEBHOOK_AUTO_DISABLE_THRESHOLD` in `common.server.ts`.
**Why:** R2 — the worker path would have been a 3rd duplicate of the magic number. Kept
DRY across the app-dispatcher and worker health-field updates.

## D4 — `deliverRow` + `processWebhookDeliveryBatch` exported (RT5/RT6)
**Plan:** did not specify exports.
**Actual:** both are `export`ed so the integration tests can drive the real primitives
directly (T-nonchain asserts `deliverRow`'s `{inserted}` discriminator on the non-chain
path; T-obs/T-crash/T-deadletter drive `processWebhookDeliveryBatch`).
**Why:** RT5 (test call-path must include the production primitive) / RT6 (new behavior
needs a test targeting the real export, not a copied SQL string). `reapStuckWebhookDeliveries`
is likewise exported, matching the existing `reapStuckRows`/`reapStuckDeliveries` convention.

## Review round 2 deviations (external re-review, commit after 9ff8e788)

## D5 — parallel work-item delivery + bounded WEBHOOK_DELIVERY_BATCH_SIZE (F1)
The delivery loop processes work items in parallel chunks of a new
`WEBHOOK_DELIVERY_CONCURRENCY` (=4, distinct from the subscriber-level `WEBHOOK_CONCURRENCY`)
via `Promise.allSettled`, and claims `AUDIT_OUTBOX.WEBHOOK_DELIVERY_BATCH_SIZE` (=8) so the
serial chunk depth `ceil(batch/concurrency)` × per-item worst case (2 × 51s = 102s) stays
under half the PROCESSING lease — otherwise a batch of unreachable webhooks holds the lease
past the timeout, letting the reaper reset in-flight rows → duplicate/concurrent delivery.
`WEBHOOK_FETCH_TIMEOUT_MS` / `WEBHOOK_RETRY_DELAYS_MS` extracted from the dispatcher's magic
numbers (R2). audit.ts imports these from common.server.ts — one-directional, no cycle.

**Correction (R2b)**: the first R2 attempt bounded the batch but kept a SERIAL loop and
wrongly multiplied the batch by `WEBHOOK_CONCURRENCY` — which parallelizes only subscribers
within one item, not items. A re-review caught that the serial worst case was still
batch × 36s (720s ≫ 300s lease). Fixed by making item processing genuinely parallel (at the
user's direction to actually parallelize rather than shrink the batch) and correcting the
formula/tests to the real model.

## D6 — onError callback for recoverable delivery errors (F2)
`deliverSingleWebhook`/`deliverToWebhookRecords` gained an optional `onError`. The durable
worker path passes it and retries the work item on a recoverable (crypto/DB) error instead
of marking SENT; the app fire-and-forget path passes none (unchanged log-and-drop). This
was NOT in the original plan — the plan (and the T-adj test) had accepted the silent skip,
which the re-review correctly identified as a durability hole (parity with the reverted-then-
re-derived didInsert lesson: "silent skip as correct" is the recurring trap).

## D7 — follow-up migration for CHECK + column-scoped grants (F3/F4)
`20260715001000_webhook_deliveries_review_hardening` adds the scope/team_id CHECK constraint
and narrows the worker's UPDATE on the webhook tables to the health columns. A separate
migration (not an edit to the already-committed `20260715000000`) because the first was
committed in 9ff8e788.

## D11 — per-lookup DNS timeout + lease guard in env-validation (R2e re-review)
Two follow-ups to D9/D10:
- **One-family DNS survival**: the first DNS-timeout form wrapped ONE deadline around
  `Promise.allSettled([resolve4, resolve6])`, so if A resolved instantly but AAAA hung, the
  outer timeout rejected the whole thing and discarded the usable IPv4. Fixed to wrap EACH
  lookup in its own `withDnsTimeout`, then allSettle those — total ceiling stays ~5s, but a
  fast family survives the other's hang. Test: `a fast A record is USED even when AAAA hangs`.
- **Env-validation lease guard**: `validateWebhookDeliveryLease` fired at `worker.start()`, but
  `--validate-env-only` exits before `start()`, so a too-small OUTBOX_PROCESSING_TIMEOUT_MS
  (10s) passed config validation. Now the entry script validates the parsed timeout right after
  Zod parse (before the --validate-env-only exit), so both paths reject it. The worker's
  start() guard is kept as defense-in-depth for programmatic createWorker callers. Test:
  `exits 1 with a lease error when OUTBOX_PROCESSING_TIMEOUT_MS is too small`.

## D10 — lease constants moved to a server-only module (R2c re-review, build fix)
Folding `DNS_RESOLVE_TIMEOUT_MS` into the lease computation inside
`@/lib/constants/audit/audit` made that file transitively import `node:dns` (via
external-http). `audit.ts` is imported by Client Components (webhook settings cards read
AUDIT_ACTION labels), so `next build` FAILED ("chunking context does not support external
modules: node:dns/promises"). Moved `WEBHOOK_WORST_CASE_PER_ITEM_MS`,
`WEBHOOK_DELIVERY_BATCH_SIZE`, and `validateWebhookDeliveryLease` to a server-only sibling
`webhook-delivery-lease.server.ts`; `audit.ts` no longer imports external-http and
`AUDIT_OUTBOX` dropped its batch field. `validateWebhookDeliveryLease(timeoutMs?)` is now
pure over its argument so the reject/accept boundary is unit-testable directly.
Also: A/AAAA DNS lookups now run CONCURRENTLY under ONE `DNS_RESOLVE_TIMEOUT_MS` deadline
(were serial = 2× the budget), so the per-item worst case (51s) is accurate.

## D9 — bounded DNS resolution + DNS in the lease model (R2c re-review)
A re-review noted the per-item worst case (fetch timeout + backoffs) excluded DNS resolution,
and `resolve4`/`resolve6` have no built-in timeout — so a slow resolver could blow the lease
budget the batch bound relies on. Added `withDnsTimeout` (`DNS_RESOLVE_TIMEOUT_MS` = 5s, via
`Promise.race`) in `external-http.ts::resolveAndValidateIps` (applies to ALL external-HTTP SSRF
callers, not just webhooks), and folded the DNS budget into `WEBHOOK_WORST_CASE_PER_ITEM_MS`
(`MAX_RETRIES × (DNS + fetch) + backoffs` = 51s). Batch is now 8, serial depth 2 × 51s = 102s
≤ 150s. The env-schema min for `OUTBOX_PROCESSING_TIMEOUT_MS` (10s) was left unchanged: it is
shared with the audit-outbox delivery path (no lease constraint), and `validateWebhookDeliveryLease()`
already fail-closes the worker at startup for any timeout too small to hold one item — the
correct layer for a webhook-specific invariant.

## D8 — writeDirectAuditLog scope/teamId opts (F5 + dead-letter parity)
`writeDirectAuditLog{,InTx}` gained an optional `{scope, teamId}` and the audit_logs INSERT
now carries team_id. TEAM webhook failure + dead-letter events record TEAM scope + teamId
(the app dispatcher's prior behavior); all other callers default to TENANT/null.

## Pre-existing, out-of-scope (recorded, not fixed)
- **eslint-disable @typescript-eslint/no-explicit-any** at
  `audit-outbox-retention-purge-audit-atomicity.integration.test.ts:202` — a Proxy
  `$transaction` override cast in a test fixture, introduced by a PRIOR branch commit
  (`6ea11fb8`), not this EXT-2 diff. Passes lint (disable is respected). Not touched:
  it is outside the EXT-2 change surface and editing it risks the FAILED-tx injection test.
