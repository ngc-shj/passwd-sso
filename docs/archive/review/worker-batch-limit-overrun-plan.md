# Plan: worker batch writes exceed their LIMIT (`#870`)

Revision 7 (after plan review rounds 1-6, see `worker-batch-limit-overrun-review.md`).

## Project context

- Type: web app + workers (Next.js 16, Prisma 7, PostgreSQL 16).
- Test infrastructure: unit + integration (real Postgres) + E2E + CI/CD.
- Verification environment constraints:
  - **VE1**: integration tests need local Postgres with the audit workers stopped (CLAUDE.md). `verifiable-local` / `verifiable-CI` (`ci-integration.yml`).
  - **VE2**: the workers run as esbuild CJS bundles. `verifiable-local` (pre-pr `Smoke: worker-bundle-boot`).

## Objective

A worker batch write that bounds its rows with a `LIMIT` subquery must touch at most that many rows. Today it can touch more. The cause:
- PostgreSQL may put an `IN (SELECT …)` or `= ANY (SELECT …)` subquery on the inner side of a Nested Loop Semi Join and rescan it once per outer row.
- When that subquery takes row locks (`FOR UPDATE`), each rescan's LockRows skips a row this same statement already updated (it is self-modified), so `LIMIT` admits the next row. The outer scan then updates that row too if it reaches it later in heap order.
- So an overrun needs a lock (A, B, E overran; the lock-free C stayed at 2) and an outer scan order that matches the subquery's order. With distinct values, ascending heap order overran (G) and descending did not (H). Tied values always line up, because a btree orders equal keys by heap TID, so every tied attempt overran.
- The fix (C1) evaluates the key set once and does not depend on any of this.

CI symptom: on PR `#869`, `audit-outbox-sweep-caps.integration.test.ts` › "reaps exactly `limit` of 3 eligible rows per call" received 3 with limit 2.

### Probe

`docs/archive/review/worker-batch-limit-overrun-probe.sql` (committed, rolls back; the run command is in its header). It uses 3 eligible rows with `LIMIT 2`, with the rescanning plan forced by `SET LOCAL enable_hashagg/hashjoin/mergejoin/material/sort = off`.

| Case | Shape | Rows touched |
|---|---|---|
| A | `IN (SELECT … ORDER BY … LIMIT 2 FOR UPDATE SKIP LOCKED)` (reaper as written) | **3** |
| B | `IN (SELECT … LIMIT 2 FOR UPDATE)`, no `ORDER BY` | **3** |
| C | `IN (SELECT … ORDER BY … LIMIT 2)`, no lock (tied keys) | 2 |
| D | C1 shape: `WITH picked AS MATERIALIZED (<A's subquery>) UPDATE … WHERE id IN (SELECT id FROM picked)` | 2 |
| E | `= ANY (SELECT … LIMIT 2 FOR UPDATE SKIP LOCKED)` | **3** |
| F | `= ANY (ARRAY(SELECT … LIMIT 2 FOR UPDATE SKIP LOCKED))`, uncorrelated (InitPlan) | 2 |
| G | A with distinct values ascending in heap order | **3** |
| H | A with distinct values descending in heap order | 2 |

Plan-review probes (rounds 2-3, security) also overran with a materialized CTE nested inside an expression subquery and correlated to the outer row (`IN (WITH p AS MATERIALIZED (… o.tenant_id … LIMIT … FOR UPDATE) SELECT id FROM p)`, re-evaluated per row), and with: a correlated `ANY (ARRAY(SELECT … LIMIT … FOR UPDATE))` (a per-row SubPlan); `IN ((SELECT …))`; `IN (WITH … SELECT …)`; `FETCH FIRST n ROWS ONLY`; and a derived table `IN (SELECT id FROM (SELECT … LIMIT … FOR UPDATE) s)`.

A lock-free subquery reads the statement's snapshot and skips nothing, so no overrun mechanism is known for it. M7–M15 are converted by choice (see C1).

## Requirements

- FR1: every member of the class below touches at most its `LIMIT` per statement, whatever plan PostgreSQL picks.
- FR2: a new bounded write in a rescannable shape is refused in CI.
- FR3: the existing sweepBounds guard (INV4) recognises the fixed shape as bounded without loosening for any other shape.
- NF1: no change to which rows qualify, to the claims' and reapers' ordering intent, to `RETURNING` projections, or to audit emission.

## Contracts

### C1: the key set is evaluated once

Each member selects its keys in a `MATERIALIZED` CTE, and the write reads them from the CTE:

```
WITH picked AS MATERIALIZED (<the existing subquery, unchanged>)
<UPDATE|DELETE> … WHERE (<keys>) IN (SELECT <keys> FROM picked) [existing extra predicates] [RETURNING …]
```

- The subquery keeps its predicate, `ORDER BY`, `LIMIT` and locking clause unchanged. No tiebreaker is added (probe D).
- The outer predicates stay. Examples: the claims' `AND status = 'PENDING'`, and M15's `AND status = 'PENDING'` compare-and-set.
- A member already written as `WITH deleted AS (DELETE …)` gains `picked` earlier in the same `WITH` list.
- Composite keys use the same row-value `IN`.
- Each statement stays in its current call position: a `$queryRawUnsafe` / `$executeRawUnsafe` literal, or `renderSql(trustedSql…)`. That keeps it inside the `#635` raw-SQL gate unchanged.

**Member set (R42).** Derivation:

```
grep -rnE 'LIMIT +(\$[0-9]+|\$\{|[0-9]+)' src scripts prisma | grep -vE '\.test\.|__tests__|/e2e/|\.md:'
```

Each hit was then read and kept only if its `LIMIT` bounds the rows of an `UPDATE` / `DELETE`.

Other spellings checked with no production hit (security review round 1):
- `ANY (SELECT`, `USING (SELECT`, `FROM (SELECT`, `ARRAY(SELECT`;
- bounded writes in `prisma/migrations` (`grep -rniE 'LIMIT' prisma/migrations`);
- `updateMany` / `deleteMany` with `take` / `limit`.

| # | File | Function | Lock |
|---|---|---|---|
| M1 | `src/workers/audit-outbox-worker.ts` | `claimBatch` (outbox claim) | FOR UPDATE SKIP LOCKED |
| M2 | same | `processDeliveryBatch` claim | FOR UPDATE SKIP LOCKED |
| M3 | same | `processWebhookDeliveryBatch` claim | FOR UPDATE SKIP LOCKED |
| M4 | same | `reapStuckRowsInTx` | FOR UPDATE SKIP LOCKED |
| M5 | same | `reapStuckDeliveriesInTx` | FOR UPDATE SKIP LOCKED |
| M6 | same | `reapStuckWebhookDeliveries` | FOR UPDATE SKIP LOCKED |
| M7 | same | `purgeRetention`: `audit_deliveries` | none |
| M8 | same | `purgeRetention`: `webhook_deliveries` | none |
| M9 | same | `purgeSentAgedInTx` | none |
| M10 | same | `purgeFailedAgedInTx` | none |
| M11 | `src/workers/retention-gc-worker/sweep.ts` | `sweepExpiryEntry` | none |
| M12 | same | `sweepGuardedExpiryEntry` | none |
| M13 | same | provenance-audit sweep (`RETURNING`) | none |
| M14 | same | per-tenant age sweep | none |
| M15 | same | `sweepExpiredAccessRequests` | none |

Non-members, read and excluded: the trashed-entry `SELECT … LIMIT ${batchSize}` in `sweep.ts`, `audit-chain-verify` (route + worker), the `LATERAL … LIMIT 1` in `scripts/tenant-domain.ts`, and `scripts/migrate-account-tokens-to-encrypted.ts`. All are standalone selects.

M7–M15 are converted without a shown overrun. A lock-free rescan is not guaranteed to repeat its rows, and one shape across the class keeps C2 and C4 simple. This is a choice, not a proven defect.

- **Control class:** enforceable boundary for the listed members. Adjudication: the PostgreSQL executor evaluates a `MATERIALIZED` CTE once per statement (probe D, `CTE Scan`).
- **Forbidden pattern:** none expressed as a regex. C2 is the check.
- **Acceptance:**
  - M1–M15 have the C1 shape.
  - Return values and `RETURNING` projections are unchanged.
  - The worker bundles boot (VE2).

### C2: CI refuses a LIMIT outside a materialized key set

Enumerating rescannable shapes did not converge in review: each round found spellings the previous list missed (ANY, correlated ARRAY, `IN ((…))`, `IN (WITH …)`, FETCH, derived tables). The gate therefore refuses the class instead of listing its members.

New gate `scripts/checks/check-limited-subquery-write.mjs`. It parses every non-test `.ts .tsx .mts .cts .js .mjs .cjs` file under `src/`, `scripts/` and `prisma/` with ts-morph. It walks files with `scripts/checks/lib/ast-project.mjs` (`walkSourceFiles` / `collectSourceFiles`), which owns the shared exclusion policy: test files, `__tests__` directories, `.spec.` and refusing symlinks. That helper accepts only `.ts`/`.tsx` today. It gains an optional extension set: the default stays `.ts`/`.tsx`, so existing adopters are unchanged, and the `.test`/`.spec` suffix match is widened to the same set. The self-test has one deny fixture per extension, plus rows for a file under `__tests__` and for a symlink. It reads every string, no-substitution template and template literal generically. Substitutions are opaque tokens, and the gate never matches a tag name. The literal text goes through a SQL scanner (shared with C4) that:
- skips comments, quoted identifiers and string literals;
- tracks parenthesis depth;
- recognises a write statement by an `UPDATE` / `DELETE` keyword in statement position: the start of the literal, after `;`, or the start of a CTE body (M9/M10's `WITH deleted AS (DELETE …)`). `FOR UPDATE` / `FOR NO KEY UPDATE` does not count.

Rule: in a literal holding a write statement, every `LIMIT` and every `FETCH FIRST|NEXT` token must sit at the top level of the body of a CTE declared `AS MATERIALIZED (` in a WITH list at the literal's parenthesis depth 0 (the write statement's own WITH list). A materialized CTE nested inside an expression does not count: correlated, it is re-evaluated per row. The `MATERIALIZED` check is token-exact, so `NOT MATERIALIZED` does not count. Any other position denies. That covers every form above with one rule, plus a non-materialized CTE, which is inlined back into the rescannable shape. The output names the file and line and gives the C1 shape. The gate fails closed when it analyses 0 files or a file fails to parse.

- **Control class:** best-effort tripwire. Adjudication is a lexical reading of literal text, not the SQL parser. Every LIMIT position C2 allows is one that C4's LIMIT-location clause also accepts. C2 says nothing about writes without a LIMIT, which are C4's concern.
- **Declared bypasses** (in the gate header, each pinned by a self-test allow row):
  - SQL split across several literals or built by concatenation;
  - the bounding subquery placed in a separate `trustedSql` fragment;
  - SQL in `prisma/migrations/*.sql` and plpgsql bodies.
- **Recovery path:** review, plus the C3 integration tests for known members.
- **Raw-SQL gate (`#635`):** the gate spells none of `renderSql` / `trustedSql` / `sqlIdentifier` / `joinSql` as a literal, and `check-raw-sql-usage.mjs` exemptions do not change.
- **Wiring:** registered where `check-raw-sql-usage.mjs` is registered in `scripts/pre-pr.sh`. CI's static-checks job runs pre-pr in `PRE_PR_STATIC_ONLY` mode.
- **Self-test:** `scripts/__tests__/check-limited-subquery-write.test.mjs`, table-driven, in the layout of `check-raw-sql-usage.test.mjs`.
  - Deny: each M1–M15 shape exactly as before the fix, including the M11 template shape and M9's `WITH deleted AS`; every overrunning form listed under Probe; `FROM (…)` / `USING (…)` with a LIMIT; a non-materialized CTE; `AS NOT MATERIALIZED`; `LIMIT` nested one level inside a materialized body; a materialized CTE nested inside `IN (…)` or `ARRAY(…)`, uncorrelated and correlated.
  - Deny: the pre-fix M1 shape in one file per scanned extension (`.ts .tsx .mts .cts .js .mjs .cjs`).
  - Skipped: the same shape in a file under `__tests__/`, and in a `.test.` / `.spec.` file of each extension.
  - Error: a symlink under a scan root fails the gate, matching `ast-project.mjs`'s refusal.
  - Allow: each C1 shape; a standalone `SELECT … LIMIT`; a `SELECT … FOR UPDATE … LIMIT` with no write statement; `IN (SELECT …)` without `LIMIT`; a SQL comment or string holding the old shape; one row per declared bypass.
  - Red proof: disable each rule clause on a scratch copy, and its rows flip.

### C3: tests that execute the members

**Test seams.** M4, M5, M9 and M10 already take a transaction. Add exported InTx functions for M1, M2, M3, M6, M7 and M8. The production wrapper calls the seam inside its existing `$transaction`, after `setBypassRlsGucs`, so production behaviour is unchanged. No seam sets the bypass GUCs itself: neither the six new seams nor M4, M5, M9 and M10, whose `setBypassRlsGucs` call moves into their wrappers. Each seam calls one shared helper. The helper asserts `app.bypass_rls = 'on'` and `app.bypass_purpose = AUDIT_WRITE`, and throws otherwise. So importing a seam cannot carry an RLS bypass into a caller's transaction (R54). `app.tenant_id` is not asserted: with `bypass_rls = 'on'` asserted, the policies' bypass arm makes `app.tenant_id` irrelevant to row visibility. The wrappers still set the NIL sentinel. A seam keeps every audit write that must commit with its state change (for example `writeDirectAuditLogInTx` in `reapStuckWebhookDeliveriesInTx`). The new seams are:
- `claimOutboxBatchInTx(tx, batchSize)` (M1);
- `claimDeliveriesInTx(tx, batchSize)`, which returns the claimed ids (M2's claim only, without the delivery loop);
- `claimWebhookDeliveriesInTx(tx, batchSize)` (M3);
- `reapStuckWebhookDeliveriesInTx(tx, limit)` (M6);
- `purgeDeliveryRetentionInTx(tx, sentCutoff, failedCutoff, limit)` (M7);
- `purgeWebhookDeliveryRetentionInTx(tx, sentCutoff, failedCutoff, limit)` (M8).

**Guard tests.** For each of the ten seams, calling it in a transaction without the GUCs, or with a different purpose, throws. The test catches the error inside the holding transaction, re-reads its eligible fixture rows, and asserts they are unchanged, so an assert placed after the write would fail. Red proof: move the assert below the write on a scratch copy.

**Wrapper tests and unit mocks.** Every transaction mock in `src/workers/audit-outbox-worker.test.ts` models the GUC state: the assert query returns `on` / `audit_write` only after `set_config` ran on that same mock transaction. Each wrapper (`claimBatch`, `processDeliveryBatch`, `processWebhookDeliveryBatch`, `reapStuckRows`, `reapStuckDeliveries`, `reapStuckWebhookDeliveries`, `purgeRetention`) gets a unit test: the GUCs are set, then the seam's statement is issued. `claimBatch` has no real-DB caller, so this test is its only proof. Red proof: remove `setBypassRlsGucs` from `claimBatch` on a scratch copy. After the change, every `not.toHaveBeenCalled` / `toBeUndefined` test in that file is re-checked for vacuity.

**Forced-plan cap tests for M1–M6** (integration, rollback-fenced through `runInRolledBackTx`):
- Inside the holding transaction, the test runs `SET LOCAL enable_hashagg = off, enable_hashjoin = off, enable_mergejoin = off, enable_material = off, enable_sort = off` and asserts the GUC took effect with `SHOW`.
- These members are global (not tenant-scoped). Before inserting its own rows, the test makes every ambient eligible row ineligible through the holding transaction's own handle. The mechanism is an UPDATE of the member's eligibility column only: `next_retry_at = 'infinity'` for the PENDING claims (M1–M3), `processing_started_at = now()` for the PROCESSING reapers (M4–M6). It never deletes (the `audit_outbox` delete guard), never changes `status`, never touches triggers or `session_replication_role`, and never commits. The test then asserts that none remain. A row committed by a live dev server between that check and the statement can still interfere; this is the same accepted residual as the existing reaper tests, and it cannot happen in CI.
- It inserts `limit + 1` eligible rows sharing one precomputed value in the member's `ORDER BY` column, bound once and reused for every row. It asserts exactly `limit` changed, then the remainder, then 0.
- It also runs an allow-side case with exactly `limit` rows: all `limit` change.
- Red proof: run against the pre-fix SQL (the test lands before C1) and record each member's red. A member whose red cannot be produced with tied values gets an entry with its observed `EXPLAIN` in `docs/archive/review/worker-batch-limit-overrun-deviation.md`.

**M7, M8:** rollback-fenced exact-cap tests (`limit + 1` eligible rows, then exactly `limit` deleted), following the existing M9/M10 tests. These are lock-free deletes, so no forced plan is needed. As with M9/M10, aged terminal rows already on a shared dev DB make the remainder steps fail loudly. They can never pass a broken cap, and CI starts empty. This residual is accepted.

**M7–M15:**
- The unit tests that pin SQL text change to the C1 shape: `sweep-sql.test.ts`, `sweep-per-tenant-age.test.ts`, `sweep-access-request-expiry.test.ts`, and `audit-outbox-worker.test.ts` where it pins SQL.
- The existing integration cap tests must stay green.

The C2 and C4 self-tests are part of C3's acceptance.

### C4: sweepBounds (INV4) recognises the C1 shape

`src/__tests__/workers/worker-policy-manifest.test.ts`, assertion 12 (`isKeySetLimited`), currently needs the contiguous pre-fix shape. Its lazy `[\s\S]*?\bLIMIT\b` crosses the IN group's closing parenthesis, so it accepts a statement whose only LIMIT is elsewhere. The review also found it accepts an IN behind `OR` and a non-key IN column.

Change, using the scanner shared with C2:
- The pre-fix contiguous match is bounded to the IN group's own depth. After C1 no member uses that shape.
- A write statement is accepted as bounded when all of these hold:
  - its WHERE has `(<keys>) IN (SELECT <keys> FROM <cte>)` as a top-level AND conjunct (not under OR or NOT);
  - the IN body is exactly that select, with no set operation, join or further FROM item;
  - `<keys>` are the table's primary-key columns (`pkColumnsOf`), or the identical `${…}` text in both positions (M11/M12);
  - `<cte>` is declared `AS MATERIALIZED` in the statement's WITH list;
  - its body has a top-level `LIMIT` that is not `ALL` or `NULL`.
- The target table and the set of write statements come from the scanner's statement-level write keyword, not from `tableOf` / `SWEEP_CANDIDATE_RE`. Under C1, `tableOf` reads `SKIP` from `FOR UPDATE SKIP LOCKED`, and the candidate regex is case-sensitive.
- C2 and C4 share one scanner module in `scripts/checks/lib/` (R48). This is outside the per-gate self-test requirement of `check-gate-selftest-coverage.sh`, but the module still gets its own unit tests. The test imports it, as `crypto-auth-deps-manifest.test.ts` imports `scripts/checks/lib/ast-project.mjs`.

**Control class:** best-effort tripwire, as the regex it replaces was. It decides lexically over source literals. Declared residuals, each pinned by an allow row:
- `picked` redeclared in a nested WITH scope (the IN binds to the inner, unbounded CTE);
- a literal holding a second, unbounded write next to a bounded one;
- `${…}` key lists: C4 checks that the same substitution text appears in both positions, but cannot resolve it to a primary key;
- an opaque `${…}` target table (M13, M14) resolves to the default `id` key.

Unrecognised shapes stay "unbounded" and deny.

Pairs:
- Deny: the CTE body without LIMIT plus `NOT EXISTS (… LIMIT 1)`; IN under OR; an IN body with UNION; with a JOIN; with a second FROM item; a non-key IN column; `LIMIT ALL`; `LIMIT NULL`; a CTE without MATERIALIZED; IN reading a different CTE name; a lowercase unbounded write.
- Allow: each C1 member shape; a C1 shape with `FOR UPDATE` on a table with a `PK_BY_TABLE` override.

Each clause is red-proven.

Also, in `scripts/checks/worker-policy-manifest.json`, replace every line-range citation in the audit-outbox-worker and retention-gc-worker entries with a subject citation (function or statement name). Update the comments that tie M15 to the contiguous shape: on `sweepExpiredAccessRequests`, and in `sweep-access-request-expiry.test.ts`.

## Testing strategy

- Unit: `npx vitest run` (SQL-shape tests, the C2 self-test, the C4 pairs).
- Integration (VE1): `docker compose stop audit-outbox-worker retention-gc-worker && npm run test:integration`.
- `npx next build` and `scripts/pre-pr.sh` (worker bundle smoke, VE2).

## Considerations & constraints

### Scope contract

- **SC1**: SQL functions in migrations. None is bounded today, so no migration is needed. C2 declares the gap.
- **SC2**: ordering tiebreakers. They are not needed for FR1 (probe C/D), and no requirement asks for fairness.
- **SC3**: functions that set `app.bypass_rls` on a transaction they receive keep doing so: the retention-gc sweeps M11 `sweepExpiryEntry`, M12 `sweepGuardedExpiryEntry`, M13 `sweepAuditProvenanceEntry`, M14 `sweepPerTenantAge`, M15 `sweepExpiredAccessRequests`, and the non-member `sweepAuditLogs`. Derivation: `grep -n "set_config('app.bypass_rls'" src/workers/retention-gc-worker/*.ts`, restricted to functions with a TransactionClient parameter. Moving the setter means changing the registry dispatch in `sweepOnce`. Assert-only (C3) is limited to the audit-outbox seams. Nothing outside `src/workers` imports these. Owner: a follow-up issue filed when this PR opens.

### Risks

- R1: a `MATERIALIZED` CTE holds at most `$n` keys, so the throughput cost is bounded. The worker smoke and the integration suite cover regressions.
- R2: removing `MATERIALIZED` from a member re-inlines a lock-free CTE. C2 and C4 both deny a LIMIT in a non-materialized CTE. A locking CTE is never inlined, and C2 denies it anyway for one shape across the class.

## User operation scenarios

1. Outbox backlog after a worker restart: the reaper resets at most `REAP_BATCH_SIZE` rows per pass, so rows still in flight are not reset early.
2. Webhook claim under load: a worker claims at most `batchSize`, so the batch fits the lease sizing (half the PROCESSING timeout). Otherwise the reaper could reset in-flight rows and the webhook would be delivered twice.
3. A developer adds `DELETE … WHERE id IN (SELECT id … LIMIT $1)`, `= ANY (SELECT … LIMIT …)` or `FETCH FIRST`: C2 fails in pre-pr and CI with the C1 shape in the message.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Materialized key set for M1–M15 | locked |
| C2 | Tripwire: LIMIT only in a materialized key-set CTE | locked |
| C3 | InTx seams and forced-plan tests for M1–M6; SQL-shape tests for M7–M15 | locked |
| C4 | sweepBounds recognises the C1 shape (tripwire) | locked |

## Implementation Checklist

Files to modify:
- `src/workers/audit-outbox-worker.ts`:
  - C1 for M1–M10;
  - new seams `claimOutboxBatchInTx`, `claimDeliveriesInTx`, `claimWebhookDeliveriesInTx`, `reapStuckWebhookDeliveriesInTx`, `purgeDeliveryRetentionInTx`, `purgeWebhookDeliveryRetentionInTx`;
  - one shared assert helper;
  - the `setBypassRlsGucs` call moves out of `reapStuckRowsInTx`, `reapStuckDeliveriesInTx`, `purgeSentAgedInTx` and `purgeFailedAgedInTx` into their wrappers (`reapStuckRows`, `reapStuckDeliveries`, `purgeRetention`).
- `src/workers/retention-gc-worker/sweep.ts`: C1 for M11–M15, and the M15 contiguity comment.
- `scripts/checks/lib/ast-project.mjs`: optional extension set (default `.ts`/`.tsx`), with the `.test`/`.spec` suffix widened to match.
- New `scripts/checks/lib/sql-scan.mjs` (the shared scanner, C2/C4) and its unit tests.
- New `scripts/checks/check-limited-subquery-write.mjs` (C2) and `scripts/__tests__/check-limited-subquery-write.test.mjs`. Registered in `scripts/pre-pr.sh` next to `Static: raw-sql-usage`, which CI runs through `PRE_PR_STATIC_ONLY`.
- `src/__tests__/workers/worker-policy-manifest.test.ts`: C4 (`isKeySetLimited`; table and statement extraction via the scanner) and its pairs.
- `scripts/checks/worker-policy-manifest.json`: replace line-range citations with subject citations in the audit-outbox-worker and retention-gc-worker entries.

Test trees touched (R19, derived with `grep -rlE "\b<symbol>\b" src scripts e2e` filtered to tests):
- Unit:
  - `src/workers/audit-outbox-worker.test.ts` (GUC-state mocks, wrapper tests, SQL pins);
  - `src/workers/retention-gc-worker/__tests__/{sweep-sql,sweep-per-tenant-age,sweep-access-request-expiry,sweep-isolation}.test.ts`;
  - `scripts/__tests__/ast-project.test.mjs`;
  - `scripts/__tests__/check-rls-read-context.test.mjs` (references `reapStuckRowsInTx` / `processDeliveryBatch` by name; must stay green).
- Integration:
  - `audit-outbox-sweep-caps.integration.test.ts` (forced-plan, guard and M7/M8 cap tests);
  - the callers of the changed wrappers and seams: `audit-outbox-dedup`, `audit-outbox-depth-check`, `webhook-delivery-durable`, `audit-outbox-dead-letter-unchained`, `audit-outbox-retention-purge`, `audit-outbox-retention-purge-audit-atomicity`, `tenant-claim-cli`, and the `retention-gc-*` files.

Reuse:
- `setBypassRlsGucs` (worker) and `helpers.setBypassRlsGucs` (tests);
- `runInRolledBackTx` (`audit-outbox-sweep-caps`);
- `BYPASS_PURPOSE.AUDIT_WRITE`;
- `walkSourceFiles` / `collectSourceFiles`;
- the table-driven fixture layout of `check-raw-sql-usage.test.mjs`;
- `renderSql` / `trustedSql` / `joinSql` for M11–M15.

CI parity: the new gate reaches CI through pre-pr's static mode. No other CI job is affected.
