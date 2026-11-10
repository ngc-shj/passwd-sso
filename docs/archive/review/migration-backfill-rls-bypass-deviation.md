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

## D12 — Phase 2 self-check fixes
The `20260418042050` baseline residual (team absolute-timeout overrides left empty) gets an
operator step in the runbook, and the baseline reason points to it. The 2c-subject advisory lock
and the contain NOTICE, first listed as review-verified, got killing cells. The implementation
commit's message calls the gate a closure of the class; it is a tripwire with listed bypasses, as
the plan and the gate header say — the PR body states it that way.

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
cells named; "Red" quotes the first failing assertion. C1 mutants ran through
`RLS_BACKFILL_RERUN_SQL` against the describe they target (21 departure / 12 re-key cells, both
green unmutated); a run in which no test executed is invalid and was rerun (code review round 1).

### C1 departure block
| Control | Mutation | Killing cell | Red |
|---|---|---|---|
| bypass grant | `app.bypass_rls 'on'` removed (both blocks) | C1 as passwd_app literal map | `expected { memberships: … } to deeply equal …` (17 failed) |
| restores | each of `bypass_rls`, `bypass_tables`, `purpose`, `tenant_id` restore removed | every `runBlock` (I3 sentinels) | `expected { rls: 'on', … } to deeply equal { rls: 'off', … }` (12–15 failed) |
| role gate | `rolsuper` half dropped | superuser-role skip cell | `expected [] to have a length of 1 but got +0` |
| role gate | `rolbypassrls` half dropped | bypassrls-role skip cell | `expected [] to have a length of 1 but got +0` |
| role gate | inverted | C1 literal map | 16 failed |
| role gate | `current_user` → `session_user` | `SET LOCAL ROLE passwd_app` cell | (Phase 2) |
| step-1 exclusion | logs arm removed / its tenant, action, target conjunct each loosened | C1 literal map | 2–4 failed each, `expected { memberships: … }` |
| step-1 exclusion | outbox arm removed / its tenant, action, target conjunct each loosened | C1 literal map | 3–4 failed each |
| candidate-copy exclusion | outbox arm removed; whole exclusion removed | I2 skip-count delta | (Phase 2) |
| outbox enqueue | rows filtered out | C1 outbox payload cell | `expected {} to deeply equal { …(8) }` |
| 2c conflict arm | `DO NOTHING` → `DO UPDATE` | C1 literal map | (Phase 2) |
| `updated_at` | removed from 2a / 2b / 2c / step 1, each | C1 literal map | `"unchanged"` where `"moved"` expected |
| bypass list | each of 8 tables removed | per-table table-list cells (permanent control) | bypass notice names the table |
| locks | advisory (candidates), advisory (2c subjects), tenant rows, teams, each removed | the matching lock cell (55P03) | (Phase 2 self-check; the cell names the statement that waited) |

### C1 re-key block
| Control | Mutation | Killing cell | Red |
|---|---|---|---|
| bypass grant | removed | C1 literal map | 10 failed |
| restore | `bypass_rls` restore removed | `runBlock` I3 | `{ rls: 'on' }` vs `{ rls: 'off' }` |
| step 1 | `team_key_version <= 1` → `<= 3` | C1 literal map | 2 failed |
| step 1 | `high_water = 0` removed | C1 literal map (restored entry stays pending) | (Phase 2) |
| step 1 | role condition removed | the bypass-role cells | (Phase 2) |
| steps 2 / 3 / 4 | role condition added to each | migration-superuser straggler cell | 3 failed each |
| step 2 | `>` → `<>` | `appHighWaterAbove` | hw expected 5, got 1 |
| step 4 | each of five wrap conjuncts dropped | `differsIn_*` variants | expected null, got the entry's id |
| bypass list | each of 4 tables removed | per-table table-list cells | bypass notice |
| teams lock | removed | re-key teams-lock cell | 55P03 |

### C3 gate (self-test cells; mutants via `MIGRATION_RLS_DML_GATE_UNDER_TEST`)
Reference keywords (JOIN, USING, MERGE, INSERT, UPDATE, comma items), CTE exclusion, nested grant
(`bypass_rls` and `bypass_tables`), restore required, table list exact split, `false`, EXECUTE
rules (literal mention, multi-statement, CTAS / materialized view, later literal, bypass SET in a
literal, literal-free EXECUTE in a relevant body), SET / RESET in a body, RENAME replay, MERGE ONLY,
INSERT … TABLE, `TABLE` query forms, UNION ALL TABLE, top-level reading and matview, unterminated
quote, FORCE in DO, NO FORCE replay, Unicode and dollar-quoted literals: each disabled on a copy
turned its named refusal cell red (37 mutants across Phase 2 and review round 1). The three
real-tree cells also fail under every copy-run because the copy has no `prisma/migrations`; the
named cell's failure is the signal.

### C6 scripts (mutants via `RUNBOOK_MD`)
| Control | Mutation | Killing cell |
|---|---|---|
| report positive control | removed | grant-removed cell |
| report section 1 | C1's exclusion added | section-1 literal map |
| report record flag | logs arm, outbox arm each removed; tenant, action, target conjunct of each arm each loosened | section-1 literal map (negatives per conjunct and store) |
| report section 2 | logs arm, outbox arm, action conjunct, time filter each mutated | section-2 cells |
| contain guard | team/membership tenant, tenant-row tenant, active, departed each dropped; any-vs-every | single-conjunct refusal cells, mixed list |
| contain inputs | template label, 255 bound, array shape (2-D / 3 columns / 3-D), dedupe each dropped | refusal / success cells |
| contain writes | `manual`, marker dropped; stamp → `now()`; count check removed | success / mixed-list cells |
| contain locks | each of three removed | contain lock cells (55P03) |
| contain NOTICE | `session_user` → constant | success cell (exact NOTICE) |

### Review-verified, not mutant-verified
- `app.tenant_id` set to the nil UUID (both blocks): an equivalent mutant. With the bypass granted
  and the table listed, the policy's OR short-circuits before the tenant arm's cast, so removing it
  changes nothing — including when the two blocks run in sequence as `migrate deploy` runs them
  after the first restored an unset value to `''` (checked on a copy). Kept for parity with
  `20261109162613`, whose policies it protects if a list ever falls short.
- The candidate-copy exclusion's logs arm and its conjuncts: the candidate set drives only the
  advisory count and which rows are locked; step 1 re-derives its own predicate (pinned above).
- Lock ORDER in C1 and contain: no deterministic cell distinguishes an order.
