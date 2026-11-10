# Coding Deviation Log: migration-backfill-rls-bypass

## D1 — C3: `EXECUTE` in a `DO` body is narrowed, not refused outright
Refusing every `EXECUTE` would fail closed on 9 migrations outside the member set that run DDL
through `EXECUTE format('ALTER …')` (role and column-type changes) or replay saved trigger
definitions, and a fail-closed hit cannot be baselined. The gate refuses `EXECUTE` unless its first
string literal starts with a DDL / utility word, or it has no literal and the body names no
FORCE table and no `app.bypass_` setting, or it is `EXECUTE FUNCTION` / `PROCEDURE` /
`GRANT EXECUTE ON`. Literal DML or SELECT in `EXECUTE`, and a literal-free `EXECUTE` in a body
that names a FORCE table or a bypass setting, still fail closed.

## D2 — C3: a non-literal `app.bypass_tables` value makes the list unknown
The plan's passing fixture (`20261109162613`) restores the list with `COALESCE(...)`; refusing a
non-literal value outright would refuse it. An unknown list admits nothing: any later reference to
a FORCE table in the unit is a hit.

## D3 — C3: fail-closed findings have their own name
`MIGRATION_RLS_DML_UNPARSED: <dir>:<line>: <reason>`, never baselinable and never counted as
stale. Extra env overrides: `MIGRATION_RLS_DML_CHECK_BASELINE` (baseline path) and, for the
self-test only, `MIGRATION_RLS_DML_GATE_UNDER_TEST` (red-proofs against a copy).

## D4 — C5: the `20260321100000` per-directory count (121) was taken from the gate
The other 14 directories' counts and both originals' line-level hit sets were read off the SQL by
hand; that one large count was not recounted independently.

## D5 — Baseline reasons carry two real residuals
- `20260418042050`: the `team_policies` carry of `max_session_duration_minutes` cannot be repeated
  (the column was dropped in `20260425103520`); on a migrate role without BYPASSRLS over existing
  data, a team override stayed NULL and the team inherits the tenant timeout.
- `20260725000000`: plaintext session rows it skipped are dead and purged by retention GC at expiry.

## D6 — C4: the A9 fixture builder was not extracted
C1's cells need a stamp-relative fixture set (stamp − 1 s / = / + 1 s); a new builder was written
and A9 left unchanged.

## D7 — C1: record details
`metadata.departedAt` is rendered as `to_char(stamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
the `JSON.stringify(Date)` form, so it equals `buildOutboxPayload`'s output whatever the session
time zone. The departure NOTICE adds an `outbox_rows` count. Candidates are computed once and drive
the skip count and the locks; step 1 re-derives its own predicate.

## D8 — C6: the runbook is a new page
`docs/operations/departed-member-access-backfill.md`, linked from `docs/operations/README.md` and
`deployment.md`. Contain also refuses null ids, treats a whitespace-only label as empty, sets
`updated_at` on the rows it ends, and leaves the grant to end with its transaction. The setup-doc
note went to `docs/setup/{gcp,aws,vercel}/en.md` (no other languages exist there).

## D9 — Carried-forward R10-T4 settled
The contain lock cells insert `SET LOCAL lock_timeout` right after the script's own `BEGIN;`
(a text substitution asserted to match once).

## D10 — Test hooks
`RLS_BACKFILL_RERUN_SQL` (C1 block extraction) and `RUNBOOK_MD` (C6 script extraction) point the
cells at a copy, used only for red-proofs.

## D11 — Simplify pass
The `<name>  # reason` parser was a third verbatim copy; it now lives in
`scripts/checks/lib/reasoned-allowlist.mjs`, used by `check-migration-rls-dml`,
`check-destructive-migration` and `check-migration-transaction` (identical handling in all three).
`check-destructive-wrapper-derivation`'s exempt parser stays separate: its keys contain `#`, so its
delimiter is a `#` after whitespace. Not taken: widening `sql-scan.mjs`'s dollar-tag lexing to
Unicode in place of the gate's pre-pass — it changes `tokenizeSql` for every other consumer and its
silent handling of an unterminated quote, which this gate reports as UNPARSED.

## Mutation results
Every mutant was applied to a copy in the scratchpad (never the real source) and run against the
named cells. "Red" means the named cell failed for the mutated control.

| Contract / control | Mutation | Killing cell |
|---|---|---|
| C1 2c conflict arm | `DO NOTHING` → `DO UPDATE` | C1 literal map; `SET LOCAL ROLE passwd_app` cell |
| C1 role gate | `current_user` → `session_user` | `SET LOCAL ROLE passwd_app` cell |
| C1 departure teams lock | removed | departure teams-lock cell (55P03) |
| C1 re-key step 1 | `high_water = 0` removed | C1 literal map (restored entry stays pending) |
| C1 re-key step 1 | role condition removed | the three bypass-role I2 cells |
| C1 re-key teams lock | removed | re-key teams-lock cell |
| C1 exclusion | outbox arm removed | C1 literal map |
| C1 bypass list | each of 12 tables removed | the per-table table-list cells, which run exactly this mutation as a permanent control (bypass notice naming the table) |
| C1 advisory lock | `pg_advisory_xact_lock` removed | "the advisory lock of a candidate (tenant, user)" cell |
| C1 tenant-row lock | `FOR SHARE OF tmb` removed | "a candidate's tenant_members row" cell |
| C3 reference keywords | JOIN, USING, MERGE, INSERT, UPDATE, comma items disabled | C5 per-form refusal cells |
| C3 CTE exclusion | disabled | C5 CTE cell |
| C3 nested grant / restore / table list / `false` / EXECUTE | each disabled | C5 matching refusal cells |
| C3 top-level reading, unterminated quote, FORCE-in-DO, NO FORCE replay | each disabled | C5 matching cells |
| C3 list membership | exact split → substring | C5 near-name cell |
| C3 Unicode tag mapping | disabled | C5 Unicode-tag cell |
| C6 contain tenant matches | team/membership, tenant-row each dropped | C6 single-conjunct refusal cells |
| C6 contain active / departed | each dropped | C6 refusal cells |
| C6 contain count check | removed | mixed-list refusal cell |
| C6 contain locks | each of three removed | C6 lock cells (55P03) |
| C6 contain record / marker / stamp | `manual`, marker dropped; stamp → `now()` | C6 success cell |
| C6 contain input checks | template label, 255 bound, array shape, dedupe each dropped | C6 refusal / success cells |
| C6 report section 2 | outbox arm, logs arm, action conjunct, time filter each mutated | C6 section-2 cells |
| C6 report section 1 | logs record flag mutated; C1's exclusion added | C6 report literal map |
| C6 report positive control | removed | grant-removed cell |

Review-verified, not mutant-verified (no deterministic cell distinguishes them): lock ORDER in C1
and contain; contain's `session_user` NOTICE (the cell asserts only that the user name is absent
from the payload); the outbox-store record flag in report section 1; the advisory lock taken for
2c-only subjects (SCIM-deleted users without a tenant row).
