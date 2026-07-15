# Handoff: webhook durable-delivery implementation (feature/worker-runtime-invariants)

> Status: COMPLETE. This handoff was written mid-implementation; the EXT-2 durable
> webhook-delivery work described below is now fully implemented, reviewed across
> multiple external re-review rounds, and merged onto the branch (PR #668). Kept as a
> historical record. The authoritative artifacts are
> `webhook-durable-delivery-{plan,review,deviation,code-review}.md` in this directory.

## What this session did (completed, committed)

On branch `feature/worker-runtime-invariants` (PR #668), after implementing and
triangulate-reviewing the worker runtime invariants (bounding the audit-outbox
destructive sweeps), **two external security reviews** raised 5 findings. EXT-1 / EXT-3
and the flawed-gate revert + sweep-guard tightening were handled; EXT-2 (webhook
durable idempotency) was the remaining task, and is now done.

### Completed external-review responses
- **EXT-1 (High)**: `purgeRetention`'s SENT/FAILED DELETE and its
  `AUDIT_OUTBOX_RETENTION_PURGED` emission are atomic in the same tx. Added the private
  `writeDirectAuditLogInTx(tx, ...)`. Regression test
  `audit-outbox-retention-purge-audit-atomicity.integration.test.ts` (injects a FAILED-tx
  failure via a Proxy and asserts the SENT delete+audit still committed together).
- **EXT-3 (Low)**: tightened the sweep-boundedness classifier
  (`worker-policy-manifest.test.ts`'s `classifySweeps`) to top-level analysis —
  `topLevelSql` (strips parenthesised subselects) + `isKeySetLimited`
  (`WHERE <keys> IN (SELECT <keys> ... LIMIT n)` where the IN-list keys match the
  projection) + a `PK_BY_TABLE` registry. Self-test fixtures (a)-(j).
- **Flawed-gate revert**: EXT-2's first fix (the `didInsert` gate in `processBatch`) was
  flawed (a winner crash newly dropped notifications; the non-chain `deliverRow` path also
  uses ON CONFLICT but was hardcoded `didInsert=true`, leaving duplicates), so it was
  reverted. `deliverRowWithChain`'s `{delivered, inserted}` return was kept (used by the
  C7 race test).

## EXT-2 durable webhook delivery (the remaining task — now done)

Design is contract-locked in `webhook-durable-delivery-plan.md` (C1-C5, INV-W1..W5).
Implemented:
- **New `webhook_deliveries` queue** + enum `WebhookDeliveryScope` (TENANT/TEAM),
  `@@unique([outboxId, scope, teamId]) NULLS NOT DISTINCT`, no FK to audit_outbox
  (survives purge), RLS + least-privilege worker grants.
- **Enqueue inside the winning audit tx**: `deliverRow` (with `RETURNING id`) and
  `deliverRowWithChain` call `enqueueWebhookDeliveryInTx(tx, row, payload)` only when the
  audit_logs INSERT won the ON CONFLICT — atomic + idempotent on both paths.
- **Delivery worker** `processWebhookDeliveryBatch` (parallel work-item chunks) + reaper +
  purge extension; events resolved at delivery time against the live webhook tables; the
  webhook-dispatcher delivery core is reused (HMAC/AAD/SSRF preserved).
- `dispatchWebhookForRow` removed; new unchained `AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER`
  action registered across all points (R12).

Subsequent external re-reviews hardened the parallelization introduced for the lease fix
(atomic `fail_count`, lease-vs-timeout guard, bounded/parallel DNS, a server-only lease
module to keep `node:dns` out of client bundles, TEAM tenant-ownership + CHECK constraint,
column-scoped grants, TEAM-scope failure/dead-letter audits) plus the CI RLS cross-tenant
seed/manifest for the new table. See `webhook-durable-delivery-code-review.md`.

## Key constraints / lessons (recorded in project memory)
- **R21**: implementation sub-agents may run break→observe→restore on production despite a
  prohibition; the orchestrator runs a mandatory residue grep after each batch — the grep,
  not the "restored" claim, is the audit trail.
- **Pre-existing is not a skip reason** (`feedback_no_skip_existing_code` corollary): the
  original "accept webhook duplicates as at-least-once" stance (SC3) was itself wrong.
- **git commit backticks**: backticks in a message are shell-evaluated; use a heredoc
  (`git commit -F file`).
- **`.claude/settings.json`** (rtk permission) is out of scope; excluded from every commit.
- **Shared dev DB** with a running docker worker: integration tests assert self-created
  row-id scope (resilient to the global-sweep background noise); CI uses an isolated DB.
- **CI-only gates** (`project_ci_gates_beyond_pre_pr`): pre-pr skips the DB integration
  jobs, so the RLS cross-tenant coverage/manifest gate for a new tenant-scoped table only
  fails in CI — seed it in `rls-cross-tenant-seed.sql` and add it to
  `rls-cross-tenant-tables.manifest`.
- **RTK truncates vitest/build output**: get summaries with
  `rtk proxy npx vitest run ... 2>&1 | grep -E 'Test Files|Tests |FAIL'`.

## Verification commands
```
npm run lint
rtk proxy npx vitest run 2>&1 | grep -E 'Test Files|Tests |FAIL'
rtk proxy npx vitest run --config vitest.integration.config.ts <files> 2>&1 | grep -E 'Test Files|Tests '
rtk proxy npx next build 2>&1 | grep -iE 'Compiled|error'
bash scripts/pre-pr.sh
```
