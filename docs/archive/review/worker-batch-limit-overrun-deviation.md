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
