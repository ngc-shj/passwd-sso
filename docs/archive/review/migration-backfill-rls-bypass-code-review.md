# Code Review: migration-backfill-rls-bypass
Date: 2026-11-11
Review round: 1

## Changes from Previous Round
Initial review of `1f17bc245` + `55ede325a` (full diff), on top of the Phase 2 self-check.

## Functionality Findings
- F1 [Major] The gate's `EXECUTE` narrowing (deviation D1) is not fail-closed: SQL held in a
  variable or query output, a CTAS literal, and a multi-statement literal all pass.
- F2 [Minor] A `bypass_tables` set inside a nested block / branch / loop is not refused.
- F3 [Minor] Missed shapes absent from the header's bypass list: `RENAME TO` of a forced table,
  `MERGE INTO ONLY`, `SET LOCAL app.bypass_*`, materialized-view create/refresh, `INSERT … TABLE`.
- F4 [Major] The `deployment.md` pointer sat under "Code-only release (no schema change)", so the
  before-deploy steps (report, disable webhooks) would be missed on the release that runs C1.
- F5 [Minor] C1 does not set `updated_at` on what it ends, unlike `endTeamMemberships` and contain.
C1 verified statement by statement against both originals and the app (predicates, lock order,
role gate, exclusion, re-key step 1, outbox payload, GUC restore): no finding.

## Security Findings
- S1 [Major] Same as F1, plus top-level `CREATE MATERIALIZED VIEW … AS SELECT`; D1 and the gate
  header claim fail-closed behaviour the code does not have.
Bypass scoping, role gate, outbox payload vs the worker parser, metadata reaching tenants and
webhooks, lock parity, operator-script input handling, gate wiring: verified, no finding.

## Testing Findings
- T1 [Major] The re-key rerun copy's step-4 wrap conjuncts and step-2 raise-only guard have no
  killing fixture (A10 covers only the original's file).
- T2 [Major] The Mutation results table lacks rows / excerpts for several named controls, does not
  record the `app.tenant_id` grant and the candidate-copy exclusion, and wrongly lists the report's
  outbox record flag as review-verified.
- T3 [Major] The report's section-1 record flag has negatives for two of its six conjuncts.
- Minor: T4 `deliverRow` fed the test-built payload; T5 notice listener not removed; T6 section-2
  outbox negatives differ in status too; T7 refusal snapshots miss the other tenant; T8 C1 no-hit
  cell can skip; T9 `'on '` cell tests `'ona'`; T10 a COUNTS entry taken from the gate;
  A1 (adjacent) `setTestBypass` hard-codes the purpose.

## Adjacent Findings
A1 (testing → code hygiene), above.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R3 F2/F5; R29 checked (D1 count wording); R42 15 / 59 / 59 reconfirmed; R47 F1/F3; R49 F1;
R54 OK; R5/R9 OK; R15 OK; R33/R16 OK.

### Security expert
R40 payload shape OK; R47/R48/R49 S1; R54 OK; R14 n/a; R42 OK; RS1 n/a; RS2 n/a; RS3 OK; RS4 OK;
RS5 n/a; RS6 n/a.

### Testing expert
R3 T3; R42 T2; R54 T2 (tenant_id grant); RT1 T10/T4; RT2 OK; RT3 A1; RT4 n/a; RT5 T4; RT6 OK;
RT7 T1/T2/T3; RT8 T7; RT9 n/a; RT10 T6; RT11 T5.

## Environment Verification Report
- E1 (NOBYPASSRLS migrate role): `verified-local` — C1 and C6 cells run as `passwd_app`
  (`rolsuper = rolbypassrls = false`), `npx vitest run --config vitest.integration.config.ts …`.
- E2 (a data-bearing NOBYPASSRLS deployment): `blocked-deferred` — plan E2; needs that operator's
  deploy; C1 correctness either way is covered by I1/I2 cells.
- E3 (`prisma migrate deploy` showing `RAISE`): not measured — the plan said Phase 2 would measure
  it, and it was not done. No step depends on it: C6 runs its report on every deployment instead of
  reading the warning. Anti-Deferral: worst case an operator never sees the skip warning, which C6
  already assumes; cost to measure: a scratch database and a `migrate deploy` run.

## Resolution Status
### Round 1
- F1 / S1 [Major] — the gate re-tokenizes every string literal in a `DO` body; a FORCE-table
  reference in any literal makes the body relevant and a literal-free `EXECUTE` there fails
  closed; an `EXECUTE` literal fails closed on a depth-0 `;` with more text, CTAS / materialized
  view, a bypass setting, a later literal naming a forced table, or an untokenizable literal.
  `--list` byte-identical before and after; 18 new mutants red. Modified:
  `scripts/checks/check-migration-rls-dml.mjs`, its self-test.
- F2 [Minor] — a nested non-empty `bypass_tables` set fails closed.
- F3 [Minor] — `RENAME TO` replay, `MERGE INTO ONLY`, `SET` / `RESET app.bypass_*` in a body,
  top-level materialized view, `TABLE` query forms implemented; `REFRESH MATERIALIZED VIEW`,
  `SET SCHEMA`, drop-and-recreate, and concatenated dynamic SQL listed as known bypasses in the
  gate header. Also fixed: `$` allowed inside a dollar-quote tag.
- F4 [Major] — the pointer moved to a `One-time upgrade: 20261110000000_rls_backfill_rerun`
  section that puts the report and webhook steps before `./scripts/deploy.sh`.
  Modified: `docs/operations/deployment.md`.
- F5 [Minor] — C1's three invitation expiries and step 1 set `updated_at = clock_timestamp()`;
  the literal map asserts moved / unchanged per row. Modified: the C1 migration.
- T1 [Major] — A10's fixture shapes extracted (`seedIdentityShapes`) and seeded in the C1 re-key
  describe, plus an entry with high-water above its computed max; six mutants red.
- T2 [Major] — the Mutation results table rebuilt from actual runs (22 C1 mutants run in this
  round; the first attempt ran no tests because of a wrong `-t` filter and was discarded), with
  the `app.tenant_id` grant recorded as an equivalent mutant (checked on a copy, including the
  two-block deploy sequence) and the candidate-copy exclusion as review-verified.
- T3 [Major] — per-store tenant / action / target negatives for the report's record flag; eight
  mutants red.
- T4–T7, A1 [Minor] — `deliverRow` takes the committed payload; listener removed before release;
  section-2 negatives share status with the positive; refusal snapshots cover every tenant the
  cell created; `setTestBypass` uses `BYPASS_PURPOSE`.
- T8–T10 [Minor] — the C1 no-hit cell runs unconditionally; a real `'on '` fixture; the 121 count
  recounted by an independent script (same value).
