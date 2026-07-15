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
