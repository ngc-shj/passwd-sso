# Plan Review: webhook-durable-delivery
Date: 2026-07-15
Review round: 1 (continuation convergence check — plan was already contract-locked)

## Changes from Previous Round
Initial expert review of the contract-locked plan. Three Opus experts (functionality,
security, testing) ran a convergence check against ground-truth code. No design decision
was reopened; findings are refinements to the migration, grants rationale, C3 consumer
walkthrough, and the testing strategy. All Critical/Major findings folded into the plan.

## Functionality Findings
- **F-func-1 [Major] — C2 timestamptz type mismatch.** Template `20260413100000` writes
  `TIMESTAMP(3)`; a later migration `20260413120000_convert_timestamp_to_timestamptz`
  converted all columns to `TIMESTAMPTZ(3)`. The C1 model declares `@db.Timestamptz(3)`.
  New migration must emit `TIMESTAMPTZ(3)` from the start (verified: 20260413120000 alters
  audit_deliveries.next_retry_at/processing_started_at/created_at). **Folded into C2.**
- **F-func-2 [Minor] — C3 consumer walkthrough wrong line + misleading snippet.** Non-chain
  consumer is at :1157-1159 (not :1132); `rowDelivered` must stay unconditionally true (the
  `inserted` gate is inside deliverRow's tx). **Folded into C3.**

## Security Findings
- **F-sec-1 [Minor] — enqueue role attribution inverted.** processBatch calls
  deliverRow(workerPrisma,...) — enqueue runs under passwd_outbox_worker, not the app role.
  Worker INSERT grant is correct; do NOT add app-role INSERT. No RLS deadlock (enqueue under
  setBypassRlsGucs). **Folded into C2 (role-attribution note).**
- **F-sec-crypto [note] — verify teamId: undefined for TenantWebhook** at impl to keep AAD
  byte-identical. **Folded into C4.**
- **F-sec-2 [Minor/Adjacent] — health-field UPDATE under bypass_purpose='audit_write'** vs.
  'webhook_dispatch'. Not RLS-enforced → observability only. Accepted (see Anti-Deferral).
- No Critical/Major. RLS shape, grant member-set, AAD preservation, dead-letter unchained,
  cross-tenant isolation, and SSRF pin all confirmed sound.

## Testing Findings (all folded into the Testing strategy section)
- **F-test-1 [Critical] — delivery success unobservable.** Mandate a local mock HTTP server +
  status PENDING→SENT assertion (T-obs). Fake https:// URL passes vacuously on a FAILED row.
- **F-test-2 [Critical] — shared-DB self-scoping.** deleteTestData omits the 3 webhook tables;
  exact-privilege-set tests break until the tables are added to allowedTables. Regression-gate
  "unchanged-green" claim carved out.
- **F-test-3 [Major] — INV-W1 dedup vacuous.** COUNT=1 untestable via race alone (only the
  audit_logs winner reaches enqueue); add a direct enqueue-conflict path (reaper re-enqueue).
- **F-test-4 [Major] — no non-chain RETURNING test.** Add an audit_chain_enabled=false twin.
- **F-test-5 [Major] — purge test must assert survival by id**, not count-delta.
- **F-test-6 [Minor] — audit-bypass-coverage.test.ts:63 .size** must be bumped.
- **F-test-7 [Minor] — grants test AS ctx.worker** + negative INSERT/DELETE on webhook tables.
- **F-test-8 [Minor] — events delivery-time semantics** need explicit unsubscribe/isActive:false.
- **ADJ-1 [Minor/Adjacent] — secretAadVersion<2 fail-closed** skip test on the worker path.

## Adjacent Findings
- F-sec-2 (bypass_purpose label) and ADJ-1 (fail-closed test) — both routed above.

## Anti-Deferral Log
- **F-sec-2 (bypass_purpose='audit_write' on webhook-table health UPDATEs)** — Accepted, not
  fixed. **Why:** bypass_purpose is a GUC label only; no RLS policy reads it (policies check
  app.bypass_rls / app.tenant_id). It is not an authz boundary, only a forensics label. Cost of
  threading a WEBHOOK_DISPATCH purpose through the worker's delivery tx (new GUC-set path +
  test) outweighs the observability gain for a worker that already runs under a single audit
  purpose. Revisit only if bypass-purpose forensics on webhook writes becomes a requirement.

## Recurring Issue Check
### Functionality expert
- R1: finding (F-func-2 line cite). R4: pass. R5: pass. R9: pass. R10: pass. R11: pass.
  R25: pass (migration ALTER TYPE ADD VALUE now explicit in C2). R40: finding (F-func-1).
  R42: pass. ORM type-shape: pass (raw SQL enqueue, no createMany relation-form).

### Security expert
- R3: pass. R12: pass. R13: pass. R14: pass (F-sec-1 rationale caveat). R29: pass.
  RS3: pass. RS5: pass. RS6: pass. RS-crypto-AAD: pass (verify teamId:undefined at impl).

### Testing expert
- R7: pass. R19: at-risk → addressed (F-test-2, F-test-5). RT1: at-risk → addressed (F-test-3).
  RT3: at-risk → addressed (F-test-7, F-test-8, ADJ-1). RT4: pass (audit race) / addressed
  (webhook INV-W1 F-test-3). RT5: pass. RT6: at-risk → addressed (F-test-1). RT7: pass.
  RT8: pass (F-test-6 edit). RT9: pass (grant-set tests carved out).

## Go/No-Go Gate (post-review)
| ID | Subject | Status |
|----|---------|--------|
| C1 | WebhookDelivery model + enum | locked |
| C2 | Migration (table/RLS/grants, timestamptz, ALTER TYPE) | locked |
| C3 | Atomic enqueue both paths + deliverRow RETURNING fix (corrected walkthrough) | locked |
| C4 | Delivery worker + reaper + purge + dead-letter action (teamId:undefined note) | locked |
| C5 | Revert flawed didInsert gate | locked |

All contracts locked. Proceeding to Phase 2.
