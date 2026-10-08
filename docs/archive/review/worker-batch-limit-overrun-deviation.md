# Coding Deviation Log: worker-batch-limit-overrun

## D-1: M5 and M6 have no pre-fix red under the forced plan

C3 requires each M1–M6 forced-plan test to fail against the pre-fix SQL. Results with tied values:

| Member | Result |
|---|---|
| M1–M4 | 3 of 3 rows touched with `LIMIT 2`: red |
| M5 (`reapStuckDeliveriesInTx`) | 2: not red |
| M6 (`reapStuckWebhookDeliveriesInTx`) | 2: not red |

The cause, from `EXPLAIN ANALYZE` on the real pre-fix statements under the same five GUCs:
- `audit_deliveries` and `webhook_deliveries` have no index on `processing_started_at`, so the subquery needs its own Sort.
- The planner therefore unique-ifies the subquery on the outer side: `Nested Loop → Unique → Sort → Subquery Scan → Limit → LockRows → Sort`. Every node runs with `loops=1`, so the subquery is evaluated once and never rescanned.
- M4's `audit_outbox` has an index on `(status, processing_started_at)`, which lets the planner put the subquery on the inner side, where it is rescanned.

So the defect is plan-dependent for M5 and M6. It needs a plan the current indexes do not make attractive, but it is the same statement shape as M4, which overran.

Disposition: the M5 and M6 forced-plan tests stay as post-fix cap assertions. The regression path for those two members is closed by C2, which denies the pre-fix shape statically. No further plan-forcing was added. The other way to get a red would be a temporary index created inside the rolled-back test transaction, which takes a SHARE lock on a shared table for the test's duration and adds schema DDL to a cap test; that costs more than it buys, given C2.

Anti-Deferral: this is not a deferral. The fix (C1) applies to M5 and M6. Only the pre-fix red proof is missing, and the reason is recorded above.

## D-2: write detection also checks the write's grammar

C2 identifies a write statement by an `UPDATE` / `DELETE` keyword in statement position. The scanner additionally requires `DELETE FROM <target>` or `UPDATE <target> … SET`, so prose that happens to start with "Update …" (log messages, comments rendered as strings) is not read as a write.

This narrows detection only within PostgreSQL's own grammar: every real write statement has that form. The same check gives C4 the write's target table. It therefore also covers U7: under C1, the old `tableOf` read `SKIP` from `FOR UPDATE SKIP LOCKED`.

Self-test rows pin both sides: prose allow rows, and a lowercase write deny row.

## D-3: C4 residuals J and K are closed, not residual

The plan declared two C4 residuals to be pinned as allow rows:
- J: a nested WITH scope redeclaring `picked`;
- K: a second, unbounded write in the same literal as a bounded one.

C4's acceptance rules close both:
- Each write statement is judged on its own, so an unbounded second write denies (K). A sweepBounds exemption now applies only when every write in the literal is single-row.
- `<cte>` resolves only in the write's own WITH list at depth 0. A write inside a nested WITH has its list at depth 1, so it is not accepted (J).

Both are pinned as deny rows, and each is red-proven. Allow rows pinning a residual remain only for the two `${…}` cases: identical `${…}` key text, and an opaque table that defaults to the key `id`.

Also tightened, beyond the plan: `isTopLevelSingleRowByKey` now requires a top-level conjunct that is exactly `<key> = <one value>` for every key column. `= ANY(…)`, a column-to-column comparison, OR and NOT now count as unbounded. Self-test rows (k) and (k2) pin this.
