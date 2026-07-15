# Plan: Worker Runtime Invariants (roadmap C-P2, first PR)

## Project context

- Type: `mixed` — Next.js 16 web app + long-running Node workers (tsx) + CI static-guard suite
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest, real-DB integration via
  `npm run test:integration`, `scripts/checks/*` guards, worker-policy-manifest parity test)
- Verification environment constraints:
  - VC-DB: real-DB integration tests require the dev Postgres (`passwd-sso-db-1`, currently
    running and healthy). All contracts in this plan are `verifiable-local`.
  - No macOS/CI-only paths are touched (no VC1/VC2/VC3 dependency from the roadmap).

## Objective

First PR of roadmap C-P2 ("worker runtime invariants", scoped to `audit-outbox-worker`
per roadmap SC3). Incorporates roadmap-review findings M-c, M-d, M-e, M-f, M-g
(`docs/archive/review/security-hardening-roadmap-review.md`).

Deliver the **net-new** invariants only; do NOT rebuild capabilities that already exist
(GT-P2-b):

1. Bound the unbounded destructive/reap sweeps in `audit-outbox-worker.ts` (M-d).
2. Mechanize the manifest↔code parity for sweep-boundedness and runtime-bound constants
   (GT-P2-a delta), across the full 4-worker member-set (M-d).
3. Pin the audit-chain-bypass invariant for dead-letter/reaper/purge events with a
   regression test (M-f).
4. Add the missing *concurrent* same-row delivery idempotency race test (M-c).
5. Name the explicit unchanged-green regression gate (M-c).

## Ground-truth reconciliation (verified against the repo, 2026-07-15)

- **GT-1 (idempotency already schema-enforced, three layers)**: claim-once =
  `claimBatch` `FOR UPDATE SKIP LOCKED` + `LIMIT $1` (audit-outbox-worker.ts:92-115);
  deliver-once = `INSERT INTO audit_logs ... ON CONFLICT (outbox_id) DO NOTHING` backed by
  `AuditLog.outboxId @unique` (schema.prisma:1124); fan-out-once =
  `AuditDelivery @@unique([outboxId, targetId])` (schema.prisma:1213) +
  `createMany({..., skipDuplicates: true})` (audit-outbox-worker.ts:382-390).
  **No `WorkerExecution` table exists and none is needed for this worker** — a generic
  idempotency ledger would be a redundant, weaker app-enforced layer in front of three
  schema-enforced constraints (M-e), and would create the tenant-key/RLS surface Security
  A2 warns about. → SC1.
- **GT-2 (the unbounded-sweep class — code-derived member-set, R42)**: derivation command
  and result recorded under INV4 below. Exactly **4 statements** in
  `audit-outbox-worker.ts` are unbounded multi-row sweeps: `reapStuckRows` (:788),
  `reapStuckDeliveries` (:847), `purgeRetention` outbox DELETE (:883) and deliveries
  DELETE (:919). All retention-gc sweeps are already `LIMIT`-bounded (sweep.ts:181, 219,
  280, 413; deleteMany over a LIMIT-selected id list :542/:550); anchor-publisher's two
  `updateMany` (:319/:388) are non-destructive flag updates bounded by the
  chain-enabled-tenant set; chain-verify is read-only with `LIMIT` (:72-82).
- **GT-3 (dead-letter bypass is deliberate and currently untested for chain_seq)**:
  `writeDirectAuditLog` (audit-outbox-worker.ts:398-434, private, never throws) inserts
  into `audit_logs` WITHOUT `chain_seq` / `event_hash` / `chain_prev_hash` / `outbox_id`
  (all NULL). Callers: DEAD_LETTER (:492, :816), REAPED (:823), RETENTION_PURGED (:908),
  DELIVERY_DEAD_LETTER (:695). The chain verifier scopes to `chain_seq IS NOT NULL`
  (audit-chain-verify-worker.ts:72-82), so these rows are legitimately unchained.
  `audit-outbox-null-invariant.integration.test.ts` covers `outbox_id IS NULL` allowance
  for REAPED/RETENTION_PURGED but does **not** assert `chain_seq IS NULL`, does not cover
  DEAD_LETTER, and does not assert the anchor stays unmoved — the M-f regression gap.
- **GT-4 (existing race coverage)**: the concurrent CLAIM race is already tested with a
  barrier (`audit-outbox-skip-locked.integration.test.ts`, Deferred + two worker-role
  clients, anti-vacuous both-claimed>0 guard). The DELIVER path race (two workers
  delivering the SAME row, the reap-redelivery overlap scenario) is only tested
  serialized (`audit-outbox-dedup.integration.test.ts` claim→deliver→reset→claim→deliver)
  — the M-c gap. `helpers.ts:284-310` documents `raceTwoClients` (statistical
  Promise.all) as the preferred concurrency primitive for non-holdable-lock races.
- **GT-5 (manifest mechanization state)**: `worker-policy-manifest.json` +
  `worker-policy-manifest.test.ts` already mechanically verify member-set completeness
  (code-derived: `src/workers` walk + DB-opening `scripts/*.ts` grep), file existence,
  and the `rawSql`/`destructive`/`emitsAudit`/`usesSecurityDefiner` booleans. Prose
  fields are presence-only (SC3 of that manifest). There are **no**
  `batchSize`/`maxAttempts`/boundedness fields today.
- **GT-6 (no replay surface)**: no replay/requeue endpoint for FAILED rows exists.
  `POST /api/maintenance/audit-outbox-purge-failed` deletes (never re-injects) FAILED
  rows, operator-token-gated (`op_` token + `requireMaintenanceOperator` + rate-limit 1/
  window fail-closed, tenant-bound). M-g's authz model is only needed if replay is ever
  built. → SC2.
- **GT-7 (runtime bound constants)**: `AUDIT_OUTBOX.BATCH_SIZE` =
  `envInt("OUTBOX_BATCH_SIZE", 500)` (src/lib/constants/audit/audit.ts:848; Zod
  env-schema line 303 caps 1..10000); `AUDIT_OUTBOX.MAX_ATTEMPTS = 8` (:851) seeds the
  schema defaults `@default(8)` on `AuditOutbox.maxAttempts` and
  `AuditDelivery.maxAttempts`; the worker reads `max_attempts` from the row, not the
  constant — the constant↔schema-default pair is the drift surface to mechanize.

### Plan-stage real-DB concurrency probe (required by Phase-1 rules)

The concurrency contracts reuse primitives already running against the real stack —
workers connect via a direct `pg.Pool` (max 5, `application_name` pinned; no
PgBouncer/proxy layer exists in this deployment path), so no pooler can drop lock or
isolation semantics. Probe executed at plan time against the live dev Postgres:

```
$ npx vitest run --config vitest.integration.config.ts \
    src/__tests__/db-integration/audit-outbox-skip-locked.integration.test.ts \
    src/__tests__/db-integration/audit-outbox-dedup.integration.test.ts
 Test Files  2 passed (2)
      Tests  4 passed (4)   (2026-07-15, Duration 1.06s)
```

This proves `FOR UPDATE SKIP LOCKED` disjoint claiming and `ON CONFLICT (outbox_id) DO
NOTHING` dedup behave as designed on the actual engine + driver. The new SQL in C1–C3
uses the same `WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` shape as the
already-probed `claimBatch`.

## Technical approach

- Pure code + test + manifest change. **No Prisma migration, no new env vars, no new
  endpoint, no new table.**
- New caps are fixed exported constants (not env-tunable): they are safety bounds, not
  operational tuning knobs; `envInt` promotion remains possible later without behavior
  change. This avoids touching env-schema/.env.example/check:env-docs surface.
- Cap sizing: reaper cadence is 30 s (`REAPER_INTERVAL_MS`). A cap of 1000 rows/tick
  drains ≥2.88 M rows/day — orders of magnitude above any realistic stuck/expired
  accumulation — while bounding both statement lock footprint and (for `reapStuckRows`)
  the per-row `writeDirectAuditLog` fan-out a single tick can emit. Remainders are
  drained by subsequent ticks; no in-tick drain loop (KISS).

## Contracts

### C1 — Cap `reapStuckRows`

- Signature: `reapStuckRows(prisma: PrismaClient, limit: number = AUDIT_OUTBOX.REAP_BATCH_SIZE)`
  — existing return type unchanged; trailing optional param (same injection idiom as
  `claimBatch(prisma, batchSize)`).
- SQL: keep the existing `WHERE id IN (SELECT id ... FOR UPDATE SKIP LOCKED)` shape and
  add `LIMIT $2` to the subselect (before `FOR UPDATE SKIP LOCKED`, matching
  claimBatch:107-108). Ordering: add `ORDER BY processing_started_at ASC` so the oldest
  stuck rows are reaped first (deterministic under cap; global FIFO-by-age across tenants
  — cross-tenant fairness residual documented at SC6).
- Behavior otherwise byte-identical: CASE dead-letter at max_attempts, per-row REAPED /
  DEAD_LETTER direct audit events.
- Acceptance: with `limit=2` and 3 eligible stuck rows, one call transitions exactly 2
  rows and a second call drains the remainder (C8 test).

### C2 — Cap `reapStuckDeliveries`

- Signature: `reapStuckDeliveries(prisma: PrismaClient, limit: number = AUDIT_OUTBOX.REAP_BATCH_SIZE)`.
- SQL: restructure the current plain conditional `UPDATE "audit_deliveries" ... WHERE
  status='PROCESSING' AND processing_started_at < $1` (:847-856) to the claim shape:
  `WHERE id IN (SELECT id FROM "audit_deliveries" WHERE status='PROCESSING' AND
  processing_started_at < $1 ORDER BY processing_started_at ASC LIMIT $2 FOR UPDATE SKIP
  LOCKED)`. Adding `FOR UPDATE SKIP LOCKED` aligns it with `reapStuckRows` and prevents
  the reaper from blocking behind an in-flight `processOneDelivery` row lock.
- Acceptance: same 2-of-3 + drain pattern as C1.

### C3 — Cap `purgeRetention`

- Signature: `purgeRetention(prisma: PrismaClient, opts?: { limit?: number })` with
  default `AUDIT_OUTBOX.PURGE_BATCH_SIZE`; must be **exported** (currently private —
  C8/T3 need to import it); existing return shape unchanged.
- **Split into two independently-capped branches to prevent starvation (S1)**: the
  current single outbox DELETE (:883-896) unions two disjoint retention rules — SENT rows
  older than `RETENTION_HOURS` (24 h) with no pending/processing deliveries, and FAILED
  rows older than `FAILED_RETENTION_DAYS` (90 d). Under the normal ratio (nearly
  everything is SENT), a single capped statement with no ORDER BY would fill its budget
  almost entirely with SENT rows and indefinitely defer FAILED rows — which retain the
  full `payload` JSONB (metadata/ip/userAgent PII), so the 90-day policy would silently
  become a soft ceiling. Fix: run the SENT-aged and FAILED-aged purges as **two separate
  capped DELETEs**, each `WHERE id IN (SELECT id ... ORDER BY <cutoff col> ASC LIMIT $n)`
  (SENT branch orders by `sent_at ASC`, FAILED branch by `created_at ASC`), each with its
  own budget so the FAILED tail always drains oldest-first. The deliveries DELETE
  (:919-921) likewise becomes `WHERE id IN (SELECT id ... ORDER BY created_at ASC LIMIT
  $n)`.
- **Emission preservation (F3)**: each branch keeps its `WITH deleted AS (DELETE ...
  RETURNING id, tenant_id) SELECT COUNT(*) AS purged, MIN(tenant_id::text) AS
  sample_tenant` wrapper so the `AUDIT_OUTBOX_RETENTION_PURGED` emission gate
  (`if (result.purged > 0 && result.sampleTenantId)` at :906) still fires; the combined
  per-tick purged count is the sum of both branches (metadata unchanged).
- The before-delete trigger (`audit_outbox_before_delete_guard`, migration :61-68) is
  unaffected — both branches select only SENT/FAILED rows.
- Acceptance: cap + drain pattern (C8), PLUS a FAILED-aged row is purged even when `limit`
  SENT-aged rows are simultaneously eligible (C8 starvation assertion).

### C4 — New constants

- `AUDIT_OUTBOX.REAP_BATCH_SIZE = 1000` and `AUDIT_OUTBOX.PURGE_BATCH_SIZE = 1000` in
  `src/lib/constants/audit/audit.ts` next to `BATCH_SIZE` (plain literals, no env read;
  rationale in Technical approach). Counts are row-count caps, not time values — no
  MS_PER_*/SEC_PER_* derivation applies.
- Consumer-flow walkthrough: Consumer `runReaper`/`createWorker`
  (src/workers/audit-outbox-worker.ts) reads nothing new — C1–C3 defaults bind the
  constants internally; call sites unchanged. Consumer `worker-policy-manifest.test.ts`
  reads the constant literals via regex to cross-check manifest `runtimeBounds` (C5).

### C5 — Manifest mechanization (`sweepBounds` + `runtimeBounds`)

- Manifest schema additions (worker-policy-manifest.json), per worker entry:
  - `sweepBounds: { "value": true, "exemptions": [{ "module": string, "match": string,
    "reason": string }] }` — REQUIRED for every worker with `rawSql: true`.
  - `runtimeBounds` (audit-outbox-worker only): `{ "batchSizeEnv": "OUTBOX_BATCH_SIZE",
    "batchSizeDefault": 500, "maxAttemptsDefault": 8, "reapBatchSize": 1000,
    "purgeBatchSize": 1000 }`.
- New assertions in `src/__tests__/workers/worker-policy-manifest.test.ts`, using the
  ts-morph no-Program pattern at **`src/__tests__/proxy/ast-guards.ts`** (verified
  importable in vitest; `Project({useInMemoryFileSystem:true})` + `createSourceFile` +
  fail-closed `parseDiagnostics`) — NOT `scripts/checks/ast-guards.ts`, which does not
  exist (F2/T4 path correction):
  1. **Sweep-boundedness (per module of every `rawSql: true` worker)**: collect every
     string-literal / template-literal node whose **full `.getText()`** (F1 — the whole
     `TemplateExpression` node, concatenating Head+Middle+Tail with `${…}` spans, NOT
     per-fixed-span text — retention-gc's `` `DELETE FROM ${entry.table} ... LIMIT $1` ``
     splits `DELETE FROM` and `LIMIT` into different spans, so per-span extraction would
     false-fail an already-bounded statement) contains `DELETE FROM` or a leading
     `UPDATE `. A statement passes iff it (a) contains `LIMIT`, or (b) matches the
     single-row predicate `/WHERE\s+id\s*=/`, or (c) is matched by exactly one
     `exemptions[].match` substring. Fail conditions: an unmatched sweep (no LIMIT / no
     `WHERE id =` / no exemption), an **unused** exemption (stale-allowlist symmetry), OR
     an exemption whose `match` hits **≥2** extracted statements (F4 — ambiguous
     authorization is an error, not a silent wrong-grant). **Exemption tightness (S5/S6)**:
     an `exemptions[].match` is itself rejected unless the statement it identifies
     independently satisfies a **top-level single-row equality on a PK/unique column with
     no subselect** — NOT the loose `/WHERE\s+\w+\s*=/` (which S6 showed also matches an
     equality *inside* a multi-row sweep's subselect, e.g. `WHERE status = 'PROCESSING'`
     at :798 or retention-gc's inner `WHERE tenant_id =` at sweep.ts:416, and would let a
     future unbounded sweep be exempted). Concretely: the identified statement must contain
     no `SELECT` (no subselect) AND its `WHERE` must bind a column in a small PK/unique
     allow-list (`id`, `tenant_id` where it is the table PK — the anchor case). An
     exemption may only *document* an already-safe statement, never *grant* boundedness to
     an unbounded sweep.
  2. **Runtime bounds**: assert `src/lib/constants/audit/audit.ts` contains
     `envInt("OUTBOX_BATCH_SIZE", 500)`, `MAX_ATTEMPTS: envInt("OUTBOX_MAX_ATTEMPTS", 8)`, `REAP_BATCH_SIZE: 1000`,
     `PURGE_BATCH_SIZE: 1000` (values interpolated from `runtimeBounds`), and that
     `prisma/schema.prisma` carries `@default(8)` on the `maxAttempts` lines of BOTH the
     `AuditOutbox` and `AuditDelivery` models. Filesystem-only (no @prisma/client
     import), keeping the test safe for the Prisma-generate-free context.
  3. **Self-test / RT7 proof (T4)**: a co-located `describe` drives the assertion-1
     extraction+classification function over in-memory fixture strings (no manifest, no
     real modules): (a) unbounded `DELETE FROM x WHERE status='SENT'` → flagged; (b)
     `... LIMIT $1` bounded → passes; (c) `WHERE id = $1` single-row → passes; (d) an
     exemption whose `match` no longer appears → fails as unused; (e) an over-broad
     exemption `match` on an unbounded statement → rejected (S5); (f) an exemption whose
     `match` identifies a statement whose ONLY equality is inside a subselect
     (`DELETE FROM x WHERE id IN (SELECT id FROM x WHERE status = 'PROCESSING')`) →
     rejected (S6 — the tightness gate must not accept subselect-internal equality). This
     proves the new guard is able to fail (the existing manifest test has no negative
     case). Extract the classification into a **pure exported helper taking
     `(statements, exemptions)` as inputs** so both the live assertion and the self-test
     call the same code (RT5-style), and case (e)/(f) are exercisable in isolation.
- Initial exemption member-set (code-derived, GT-2):
  - audit-outbox-worker: anchor advance `UPDATE audit_chain_anchors SET chain_seq=$1,
    prev_hash=$2 WHERE tenant_id = $3` (:341 — `tenant_id` is that table's PK, so
    `WHERE tenant_id =` satisfies the S5 single-row-shape gate).
  - retention-gc-worker: none expected (all sweeps carry LIMIT); the definer-fn call
    `audit_log_purge(...)` contains no DELETE text in-module.
  - audit-anchor-publisher / audit-chain-verify-worker: none (no raw DELETE/UPDATE
    sweep text; publisher's `updateMany` calls are ORM-level, see SC4).
- Consumer-flow walkthrough: Consumer `worker-policy-manifest.test.ts` reads
  `sweepBounds.value`, iterates `sweepBounds.exemptions[]` reading `{module, match,
  reason}` (uses `module` to scope the file, `match` to identify exactly one statement
  that must itself be single-row-shaped, `reason` presence ≥10 chars), and reads every
  `runtimeBounds` key listed above to build the cross-check regexes. All fields are
  present in the locked shape; no other consumer reads these fields.
- Manifest prose fields (`poisonMessageHandling` line refs etc.) are refreshed where
  C1–C3 move line numbers — prose accuracy stays a human-review concern (manifest SC3).

### C6 — Dead-letter unchained invariant (M-f) — regression test

- New file `src/__tests__/db-integration/audit-outbox-dead-letter-unchained.integration.test.ts`.
- Arrange: chain-ENABLED tenant (`audit_chain_enabled=true`); one outbox row delivered
  via real `deliverRowWithChain` (anchor at chain_seq=1); one PROCESSING row with
  `attempt_count = max_attempts - 1` and stale `processing_started_at` (so the reaper's
  `attempt_count + 1 >= max_attempts` CASE branch fires → FAILED/dead-letter).
- Act: call exported production primitive `reapStuckRows` (RT5 — real call path).
- Assert (each its own test):
  1. The stuck row is FAILED and an `AUDIT_OUTBOX_DEAD_LETTER` row exists with
     `chain_seq IS NULL AND event_hash IS NULL AND chain_prev_hash IS NULL AND
     outbox_id IS NULL` (SYSTEM actor). Falsifiable: fails if the dead-letter write ever
     supplied a chain column.
  2. `audit_chain_anchors.chain_seq` is still 1 (dead-lettering never advances the
     anchor). Falsifiable: fails if dead-lettering advanced the anchor.
  3. **Non-vacuous chain-continuity (T6)**: after the dead-letter, deliver a SECOND
     genuine chained row via `deliverRowWithChain` (anchor → chain_seq=2), then call
     `verifyTenantChain(tenantId, { prisma: ctx.worker.prisma, logger: { error: () => {},
     info: () => {} } })` (real 2-arg signature — `VerifyDeps { prisma, logger }` where the
     logger stub must supply BOTH `error` and `info`, scripts/audit-chain-verify-worker.ts:63-71)
     and assert the result's `walkedThrough === 2` (the real field name, not `walked`) AND
     `ok === true`. A single-element chain is trivially ok regardless of the dead-letter;
     a 2-element chain proves the unchained dead-letter row neither entered the walk nor
     broke the hash linkage between seq 1 and seq 2.
- Invariant INV3 (below) is thereby app-enforced + regression-pinned.

### C7 — Concurrent same-row delivery race test (M-c)

- New file `src/__tests__/db-integration/audit-outbox-concurrent-delivery.integration.test.ts`.
- Two worker-role clients (`createPrismaForRole("worker")` ×2) concurrently invoke the
  real `deliverRowWithChain` for the SAME claimed outbox row on a chain-enabled tenant,
  using the `raceTwoClients` statistical primitive (helpers.ts:297). Concurrency model
  (T7 — precise): `deliverRowWithChain` takes the anchor row lock via `SELECT ... FOR
  UPDATE` (audit-outbox-worker.ts:235) and holds it to commit, with `SET LOCAL
  lock_timeout='5000ms'` (:207). The second delivery lock-*waits* on the first (a
  serialization, not a deadlock — only B waits on A, no cycle); a hold-open `Deferred`
  barrier would instead force B to hit the 5 s `lock_timeout` and throw, which is why
  `raceTwoClients` (block-then-proceed) is used, not the skip-locked barrier idiom.
- **Non-vacuous guard (T1 — the central fix)**: "both returned `true`" is NOT a valid
  anti-vacuous guard — `deliverRowWithChain` returns `true` unconditionally on any
  non-paused delivery (audit-outbox-worker.ts:359; documented in dedup test :157-160),
  so two *serial* calls both return `true` and every count assertion passes with zero
  contention, making the test byte-identical to the existing serialized dedup test. To
  make the race observable, thread the outcome out of the deliver path: `deliverRowWithChain`
  gains a discriminated return (`{ delivered: true, inserted: boolean }` where `inserted`
  reflects whether the `INSERT ... ON CONFLICT (outbox_id) DO NOTHING RETURNING id`
  returned a row — the anchor-advance already keys off exactly this at :339). The RT4
  guard asserts **exactly one** call had `inserted === true` and the other
  `inserted === false` — a property that is FALSE under a broken interleave where both
  transactions insert and both advance the anchor (the regression M-c targets), and that
  a purely serial run cannot fake because the second serial delivery would still conflict
  (inserted=false). **This exactly-one-inserted property IS the non-vacuous guard** — it
  fails under both the serial-execution and the broken-interleave cases, keyed off the real
  :339 signal, with `raceTwoClients` supplying the contention.
- **Overlap guard is best-effort only (T1-R2)**: the strict "capture each client's
  `$transaction` start/end and assert overlap" is NOT implementable — `deliverRowWithChain`
  opens its own internal `$transaction` (:203) that the test does not own, so the test can
  only observe the resolved outer Promise, never the internal BEGIN/COMMIT. Do NOT specify
  a transaction-boundary overlap assertion. Optionally add a coarse wall-clock statistical
  guard (loop N iterations per the `raceTwoClients` docstring at helpers.ts:293; assert
  each op started before the other resolved) as a best-effort contention signal — never as
  the primary correctness guard (exactly-one-inserted already is). The existing sibling
  race test `audit-chain-ordering.integration.test.ts` (no overlap assertion, trusts
  `raceTwoClients` + FOR UPDATE) is the precedent.
- Distinguish `lock_timeout` throw (opB exceeded 5 s under CI load — retry, not a defect)
  from "opB inserted a second row / advanced anchor twice" (real regression): a caught
  `lock_timeout` error is treated as an inconclusive run (skip/retry once), never a pass.
  Sound because a double-insert requires opB to have run to completion (it did NOT time
  out), so skip-on-lock_timeout cannot mask the regression.
- Assert: exactly ONE `audit_logs` row for the outbox_id; anchor `chain_seq === 1`
  (advanced exactly once); exactly one `inserted===true` (the primary guard).
- **This C7 return-shape change to `deliverRowWithChain` is a locked cross-boundary
  contract** — consumer walkthrough (member-set re-derived from
  `rg -n 'deliverRowWithChain' src/`, NOT a hand-count, T-NEW/R42). `.delivered` MUST carry
  the exact prior boolean; the mechanical rule for every reader is: **read `.delivered`
  (preserves the old boolean semantics), never `.inserted`, never a truthy check on the
  whole object** (`{delivered,inserted}` is always truthy, so `expect(...).toBe(false)`
  would break):
  - Production: `processBatch` (audit-outbox-worker.ts:1065) reads the boolean to gate
    webhook/fan-out (`if (!rowDelivered)` :1070) → read `result.delivered`. Skip logic
    unchanged. (Sole production caller — grep-confirmed.)
  - `audit-outbox-dedup.integration.test.ts` (:117, :137, :155, `expect(deliveredN).toBe(true)`)
    → `.delivered`.
  - `audit-outbox-worker-respects-publish-paused-until.integration.test.ts` (:110, :203,
    :284, `expect(delivered).toBe(false|true)` — the **publish-paused skip semantics**;
    a paused row is `delivered=false`, and ALSO `inserted=false`, so reading `.inserted`
    here would pass for the WRONG reason) → `.delivered`.
  - `audit-outbox-worker-no-busy-loop-when-all-paused.integration.test.ts` (:159-168,
    `results.push(result)` into `boolean[]` then `expect(results).toEqual([false,false,false])`
    — the anti-busy-loop regression guard) → push `result.delivered`.
  - `audit-chain-ordering.integration.test.ts` (:97-105, destructures the `raceTwoClients`
    result `const [deliveredA, deliveredB] = await raceTwoClients(..., (c) =>
    deliverRowWithChain(c, rowA, ...), ...)` then `expect(deliveredA).toBe(true)` /
    `expect(deliveredB).toBe(true)` — `raceTwoClients` returns `Promise<[A,B]>` of the
    callback returns, so these ARE the deliver returns, T-NEW-3) → `expect(deliveredA.delivered).toBe(true)`.
  - `audit-chain-verify-endpoint.integration.test.ts` (:434, bare `await
    deliverRowWithChain(...)`) genuinely DISCARDs the return → TS-safe, no change needed.

### C8 — Cap regression tests (RT7-proven able to fail)

- New file `src/__tests__/db-integration/audit-outbox-sweep-caps.integration.test.ts`.
- For each of C1/C2/C3: seed `limit + 1` eligible rows, invoke the exported function
  with an injected small `limit` (e.g. 2), assert exactly `limit` rows transitioned and
  the remainder is untouched; a second invocation drains the rest. C3 additionally seeds
  `limit` SENT-aged rows PLUS ≥1 FAILED-aged row and asserts the FAILED-aged row IS purged
  in the same tick (S1 starvation guard — the two-branch split gives FAILED its own cap).
- **RT7 evidence procedure (T3 — honest form)**: the injected-`limit` form cannot predate
  the signature change, so the red-first proof is NOT "call with limit=2 against unbounded
  code." Instead: land C1–C3 (adds the `limit` param + exports `purgeRetention`), then to
  prove each cap test is able to fail, run it once with the cap **temporarily raised above
  the seed** (e.g. seed 3, pass `limit=10`) and confirm it goes RED (all 3 transition, the
  `toBe(2)` assertion fails) — demonstrating the assertion depends on the cap actually
  bounding, not on the seed count coinciding. Record that red run in the deviation log.
  The C5 assertion-3 self-test (fixture-driven) is the separate RT7 proof for the manifest
  guard.

## Invariants

| ID | Invariant | Enforcement | Notes |
|----|-----------|-------------|-------|
| INV1 | ≤1 `audit_logs` row per outbox row; the anchor advances exactly once per outbox row | **schema** (`outboxId @unique`) + app (anchor advance gated on `INSERT ... RETURNING` non-empty) | exists; pinned by C7 under real concurrency via the `inserted` discriminator (exactly-one-inserted guard) |
| INV2 | ≤1 `audit_deliveries` row per (outbox,target) | **schema** (`@@unique`) + `skipDuplicates` | exists (GT-1) |
| INV3 | Worker operational events (DEAD_LETTER / REAPED / RETENTION_PURGED / DELIVERY_DEAD_LETTER) are unchained (`chain_seq`/`event_hash`/`chain_prev_hash`/`outbox_id` all NULL), never advance the anchor, never route through the outbox; `writeDirectAuditLog` stays private and unwrapped | **app** + C6 regression test + forbidden patterns | Schema-enforced alternative (CHECK over an action list) rejected: `writeDirectAuditLog` deliberately swallows insert errors, so a CHECK-list drifting behind `OUTBOX_BYPASS_AUDIT_ACTIONS` would silently DROP audit events — an availability-of-audit-trail regression worse than the integrity risk, which the verifier's `chain_seq IS NOT NULL` scoping already contains (M-f). |
| INV4 | Every raw-SQL multi-row DELETE/UPDATE sweep in worker modules is LIMIT-bounded, single-row-by-id, or exemption-listed with a reason AND itself single-row-shaped | **CI-mechanized** (C5 assertion 1, self-tested per C5.3) | Member-set derivation (R42): `rg -n 'DELETE FROM\|UPDATE\s' src/workers/ scripts/audit-chain-verify-worker.ts` over manifest `modules` → 21 statements; 4 unbounded (audit-outbox-worker.ts:788, :847, :883, :919 — all fixed by C1–C3); 1 single-row-by-PK exemption (`audit_chain_anchors` :341); remainder LIMIT-bounded or `WHERE id =`. ORM-level bulk calls are SC4. AST pattern lives at `src/__tests__/proxy/ast-guards.ts`. |
| INV5 | Manifest `runtimeBounds` ↔ constants ↔ schema defaults cannot drift | **CI-mechanized** (C5 assertion 2) | Covers GT-P2-a's `maxAttempts:N ⇒ code constant = N` and `batchSize` declaration. The LIMIT *value* binding (constant → `$n` parameter at the call site) is left to code review — parameter-flow tracing is beyond regex/AST-lite scope; stated trust boundary. |

## Forbidden patterns

- pattern: `runWorkerJob` — reason: shared wrapper is deferred (SC1); must not appear in this diff.
- pattern: `WorkerExecution|worker_executions` — reason: idempotency ledger table rejected for this worker (SC1/M-e).
- pattern: `export (async )?function writeDirectAuditLog|import .*writeDirectAuditLog` — reason: INV3 — the bypass writer stays private to `audit-outbox-worker.ts`; exporting/importing it invites wrapping or reuse that breaks the unchained contract.
- pattern: `(enqueueAudit|logAudit)\w*\(.*(AUDIT_OUTBOX_(DEAD_LETTER|REAPED|RETENTION_PURGED)|AUDIT_DELIVERY_DEAD_LETTER)` — reason: INV3 — bypass actions must never enter the outbox (recursion / chaining). Member-set (S4/R42): the four unchained operational actions INV3 enumerates; NOT anchored on three. To defend against future drift, C5 SHOULD additionally assert every member of `OUTBOX_BYPASS_AUDIT_ACTIONS` (audit.ts:859-867) is either in this forbidden alternation or documented as never emitted via `writeDirectAuditLog` — mechanized completeness so the pattern and the bypass set cannot silently diverge.
- pattern: `ON CONFLICT \(outbox_id\) DO UPDATE` — reason: INV1 — dedup must remain DO NOTHING.

## Testing strategy

- Unit: existing `src/workers/audit-outbox-worker.test.ts` (mocked) updated where SQL
  shapes/signatures change. **Enumerated mock touch-points (T5/RT1/R19)** — these MUST be
  re-derived, not loosened to stay green:
  - SQL-detection predicates: the claim predicate `sql.includes("audit_outbox") &&
    ...("PENDING") && ...("SKIP LOCKED")` (:247-248) now also matches the C2 deliveries
    reaper (which gains `SKIP LOCKED`); disambiguate by table (`audit_outbox` vs
    `audit_deliveries`), do not broaden. The purge-detection `sql.includes("DELETE FROM
    audit_outbox")` (:258) still matches (literal text survives the subselect
    restructure), but C3's **two-branch split** adds a second `DELETE FROM audit_outbox`
    per purge — the mock's per-branch handling must account for two purge statements.
  - `txCallCount` ladders in the `reaper` and `recordError` describe blocks (e.g.
    :1060-1066, :1128-1133): C3's SENT/FAILED branch split changes the transaction count
    per `runReaper` — **re-derive the ladder from the new `runReaper` sequence, do not
    guess-bump the numbers**.
  - Positive-assertion add: assert the reaper SQL now contains `LIMIT` and `ORDER BY
    processing_started_at` so the mock verifies the C1/C2 change rather than merely
    tolerating it (keeps the mock aligned with the C8 integration cap test).
  No weakening of the existing `writeDirectAuditLog` fan-out / SENT-marking assertions.
- Integration (real DB, `npm run test:integration`): new C6/C7/C8 files.
- **Regression gate (M-c, explicit) — caller-derived, not glob-guessed (T2)**: derive the
  gate from the changed functions: `rg -l 'reapStuckRows|reapStuckDeliveries|purgeRetention|deliverRowWithChain' src/__tests__/db-integration/`. Current member-set that must pass
  **unchanged**: `audit-delivery-stuck-reaper` (calls the C2-changed `reapStuckDeliveries`
  — omitted by an `audit-outbox-*` glob), `audit-outbox-reaper`, `audit-outbox-retention-purge`,
  `audit-outbox-dedup`, `audit-chain-ordering`, `audit-chain-verify-endpoint`,
  `audit-sentinel`, `audit-outbox-worker-respects-publish-paused-until`,
  `audit-outbox-worker-no-busy-loop-when-all-paused` (all `deliverRowWithChain` callers) —
  plus the `retention-gc-*` suite (SC4 boundedness). `audit-outbox-dedup` and the other
  `deliverRowWithChain` callers WILL change (C7 return-shape → read `.delivered`); that is
  a contract-driven update, not a regression. This is the R32 behavior smoke for the
  security-audit-critical path.
- CI-mechanized: C5 assertions ride `worker-policy-manifest.test.ts` in the normal
  vitest job (filesystem-only, Prisma-generate-safe).
- Mandatory completion checks: `npx vitest run`, `npm run test:integration`,
  `npx next build`, `scripts/pre-pr.sh` before PR.

## Considerations & constraints — Scope contract

- **SC1**: `runWorkerJob` shared wrapper + `WorkerExecution` idempotency table —
  **dropped for audit-outbox-worker** (not merely deferred): all three idempotency
  layers are already schema-enforced (GT-1), which is the stronger form this repo's plan
  rules prefer; an app-level ledger in front would be redundant (M-e) and add the
  Security-A2 tenant-key/RLS surface with zero coverage gain. Rollout of any shared
  wrapper to OTHER workers remains owned by later C-P2-series PRs, to be justified
  per-worker against this same schema-enforced-first bar.
- **SC2**: poison-message replay (FAILED → re-inject) is NOT built. No such surface
  exists today (GT-6). If ever built it requires the M-g authz model (distinct operator
  scope, SYSTEM-actor audit of who replayed which outbox_id, idempotent, INV3-unchained).
  Owner: a dedicated future PR + plan.
- **SC3**: duplicate external webhook posts on crash-redelivery are accepted
  (at-least-once delivery semantics; `dispatchWebhookForRow` is fire-and-forget by
  design/R9 — fan-out ROWS are deduped by INV2, external POSTs are not). Industry-
  standard webhook contract; consumers must key on event id.
- **SC4**: ORM-level bulk calls (`deleteMany`/`updateMany` — retention-gc sweep.ts:542/
  :550 bounded by LIMIT-selected id lists; anchor-publisher :319/:388 bounded by the
  chain-enabled tenant set) are outside the C5 raw-SQL mechanization. Their boundedness
  is covered by the existing retention-gc/anchor integration suites; extending the AST
  guard to ORM argument shapes is not warranted by any current offender (YAGNI).
- **SC5**: `POST /api/maintenance/audit-outbox-purge-failed`'s unbounded DELETE is out
  of the M-d class: it is an operator-invoked one-shot (op-token + maintenance-operator
  check + fail-closed rate limit 1/window, tenant-scoped), not an unattended steady-state
  sweep. No change.
- **SC6 (accepted residual — cross-tenant reaper fairness, S2)**: the reap/purge caps are
  GLOBAL (system-wide by role privilege), FIFO-by-age (`ORDER BY <cutoff> ASC`), not
  per-tenant partitioned. A single tenant generating many stuck/aged rows can, under
  oldest-first ordering, occupy the head of the queue and delay other tenants' reaping by
  at most `backlog / cap` ticks. Bounded in practice (1000/30 s = 2.88 M/day) and only
  delays the *operational* REAPED/DEAD_LETTER event, never the primary `audit_logs`
  delivery, and never crosses tenant isolation (each write is attributed to the row's own
  `tenant_id`). Accepted; a per-tenant round-robin is YAGNI absent a demonstrated noisy
  neighbor. Owner: revisit only if fairness telemetry shows starvation.
- **SC7 (accepted residual — swallowed direct-audit-write loss, S3)**: `writeDirectAuditLog`
  swallows insert failures with a warn log only (audit-outbox-worker.ts:428-433) — a
  correct choice per INV3 (a throw would break the reaper), but a swallowed failure loses
  the audit-UI-visible operational event (DEAD_LETTER/REAPED/RETENTION_PURGED) with no
  retry (fire-once). The compensating trail is the parallel `deadLetterLogger.warn`
  structured line (:812) + primary reaper log; the residual is an operator watching the
  audit *view* could under-count dead-letters. Documented, not fixed. Optional follow-up:
  raise the swallow's warn to `error` with a stable `_logType` so it can drive a
  depth-alert-style signal — deferred, no behavior change here.
- Risk: C2 adds `FOR UPDATE SKIP LOCKED` to a previously plain UPDATE — a stuck row
  currently being locked by a concurrent transaction is now skipped for one tick instead
  of blocking the reaper; strictly better liveness, same eventual outcome. Called out for
  reviewer attention.

## User operation scenarios

1. **Worker crash mid-delivery**: row stuck PROCESSING → 5 min timeout → capped reaper
   returns it to PENDING (or FAILED at max_attempts) → redelivery hits `ON CONFLICT` →
   exactly one audit row (C6/C7 territory).
2. **Mass stuck backlog** (e.g. DB failover leaves 50k PROCESSING rows): reaper drains
   1000/30s deterministically oldest-first instead of one unbounded UPDATE holding locks
   over 50k rows while emitting 50k direct audit writes in a single tick.
3. **Retention purge after outage backlog**: 500k aged SENT rows drain at
   1000/30s (~4.2 h) with bounded per-tick lock footprint; audit UI shows per-tick
   `AUDIT_OUTBOX_RETENTION_PURGED` events with counts ≤ cap.
4. **Chain-enabled tenant with dead-letters**: operator sees `AUDIT_OUTBOX_DEAD_LETTER`
   events in the tenant audit view while scheduled chain verification stays green (C6
   asserts exactly this).

## Go/No-Go Gate

| ID | Subject                                                      | Status  |
|----|--------------------------------------------------------------|---------|
| C1 | Cap reapStuckRows (LIMIT + ORDER BY, injectable limit)        | locked |
| C2 | Cap reapStuckDeliveries (claim-shape restructure)             | locked |
| C3 | Cap purgeRetention (two-branch SENT/FAILED split, per-branch cap+ORDER BY) | locked |
| C4 | REAP_BATCH_SIZE / PURGE_BATCH_SIZE constants                  | locked |
| C5 | Manifest sweepBounds + runtimeBounds mechanization (full-node getText, self-tested, tight exemptions) | locked |
| C6 | Dead-letter unchained invariant regression test (2-element chain, M-f) | locked |
| C7 | Concurrent same-row delivery race test (inserted-discriminator + overlap guard, M-c) | locked |
| C8 | Cap regression tests + FAILED-starvation guard, honest red-first (RT7) | locked |
