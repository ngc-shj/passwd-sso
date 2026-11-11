# Coding Deviation Log: migration-backfill-rls-bypass

## D1 — C3: dynamic `EXECUTE` is a baselinable finding, not a refusal
Refusing every `EXECUTE` would fail closed on migrations outside the member set that run DDL
through `EXECUTE format('…')` (role grants, column-type changes, saved trigger and policy replays),
and a fail-closed hit cannot be baselined. Phase 2 narrowed `EXECUTE` by reading its literals; code
review rounds 1 and 2 each found SQL that slipped past the narrowing, so round 2 dropped content
analysis of dynamic SQL. An `EXECUTE` whose operand is anything but one plain string literal is
`MIGRATION_RLS_DML_DYNAMIC: <dir>:<line>`, baselinable with a reason (8 directories, 22 findings,
all DDL-only replays). A single plain literal is unquoted and scanned as a nested unit under the
enclosing bypass state; inside it a bypass setting, FORCE, a forced-table RENAME, `DO` and a
prepared `EXECUTE` fail closed. `EXECUTE FUNCTION` / `PROCEDURE` and `GRANT EXECUTE ON` are not
dynamic SQL.

## D2 — C3: a non-literal `app.bypass_tables` value makes the list unknown
The plan's passing fixture (`20261109162613`) restores the list with `COALESCE(...)`; refusing a
non-literal value outright would refuse it. An unknown list admits nothing: any later reference to
a FORCE table in the unit is a hit.

## D3 — C3: fail-closed findings have their own name
`MIGRATION_RLS_DML_UNPARSED: <dir>:<line>: <reason>`, never baselinable and never counted as
stale. Extra env overrides: `MIGRATION_RLS_DML_CHECK_BASELINE` (baseline path) and, for the
self-test only, `MIGRATION_RLS_DML_GATE_UNDER_TEST` (red-proofs against a copy).

## D4 — C5: the `20260321100000` per-directory count (121)
The other 14 directories' counts and both originals' line-level hit sets were read off the SQL by
hand. The 121 was first taken from the gate, then recounted in review round 1 by a separate
script (not the gate): replay FORCE / NO FORCE by regex over the migrations sorting before
`20260321100000` (33 forced tables), strip comments, split on `;`, count forced names after
`UPDATE … SET`, `FROM`, `JOIN`, `USING`, `INSERT INTO`. Result 121; the method is also stated
beside the COUNTS entry in the self-test.

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
Review round 2 pass: no leftovers of the removed narrowing; a nested `EXECUTE` no longer reads its
operand before refusing, and a duplicate token lookup was dropped (M20 / M35 patterns updated and
re-run). Not taken: sharing the `LOCAL` / `SESSION` skip (two lines in two helpers) and merging the
gate's `wordChar` with `sql-scan`'s (their sets differ on U+E000).

## Mutation results
Every mutant was applied to a copy in the scratchpad (never the real source) and run against the
cells named; "Red" quotes the first failing assertion. C1 mutants ran through
`RLS_BACKFILL_RERUN_SQL` against the describe they target (21 departure / 12 re-key cells, both
green unmutated); a run in which no test executed is invalid and was rerun (code review round 1).

### C1 and C6 (review round 2: every mutant re-run on a copy, unmutated describe green first)
| Contract | Control | Mutation | Killing cell | Red (first failing assertion) |
|---|---|---|---|---|
| C1 departure | role gate | `current_user` -> `session_user` | passwd_app entered with SET LOCAL ROLE (session_user bypasses, current_user does | `expect(collected.messages.some((m) => m.startsWith("team-t…`: - false / + true |
| C1 departure | candidate copy | outbox arm removed | migration-superuser: the block skips with a warning counting the candidates, cha (+2) | `expect(skipCount()).toBe(first + 1 + 6);`: - 19 / + 20 |
| C1 departure | candidate copy | whole exclusion removed | migration-superuser: the block skips with a warning counting the candidates, cha (+2) | `expect(skipCount()).toBe(first + 1 + 6);`: - 22 / + 24 |
| C1 departure | candidate copy | logs arm removed | migration-superuser: the block skips with a warning counting the candidates, cha (+2) | `expect(skipCount()).toBe(first + 1 + 6);`: - 18 / + 19 |
| C1 departure | candidate copy | logs tenant conjunct loosened | migration-superuser: the block skips with a warning counting the candidates, cha (+2) | `expect(skipCount()).toBe(first + 1 + 6);`: - 14 / + 13 |
| C1 departure | candidate copy | logs action conjunct loosened | migration-superuser: the block skips with a warning counting the candidates, cha (+2) | `expect(skipCount()).toBe(first + 1 + 6);`: - 14 / + 13 |
| C1 departure | candidate copy | logs target conjunct loosened | migration-superuser: the block skips with a warning counting the candidates, cha (+4) | `expect(skipCount()).toBe(first + 1 + 6);`: - 7 / + 0 |
| C1 departure | candidate copy | outbox tenant conjunct loosened | migration-superuser: the block skips with a warning counting the candidates, cha (+2) | `expect(skipCount()).toBe(first + 1 + 6);`: - 14 / + 13 |
| C1 departure | candidate copy | outbox action conjunct loosened | migration-superuser: the block skips with a warning counting the candidates, cha (+2) | `expect(skipCount()).toBe(first + 1 + 6);`: - 14 / + 13 |
| C1 departure | candidate copy | outbox target conjunct loosened | migration-superuser: the block skips with a warning counting the candidates, cha (+4) | `expect(skipCount()).toBe(first + 1 + 6);`: - 7 / + 0 |
| C1 departure | 2c conflict arm | `DO NOTHING` -> `DO UPDATE` | C1 as passwd_app ends exactly the memberships no record explains, expires the vo (+2) | `expect(await stateUnderTestBypass(client, fx)).toEqual(postSta…`: -     "toKept": "PENDING", / +     "toKept": "EXPIRED", |
| C1 departure | 2a status | `ti.status = 'PENDING'` dropped | I1: a second run in the same transaction changes no row and enqueues nothing | `expect(Object.values(changes).every((n) => n === 0)).toBe(true…`: - true / + false |
| C1 departure | 2b status | `ti.status = 'PENDING'` dropped | I1: a second run in the same transaction changes no row and enqueues nothing | `expect(Object.values(changes).every((n) => n === 0)).toBe(true…`: - true / + false |
| C1 departure | 2c status | `ti.status = 'PENDING'` dropped | I1: a second run in the same transaction changes no row and enqueues nothing | `expect(Object.values(changes).every((n) => n === 0)).toBe(true…`: - true / + false |
| C1 departure | 2a boundary | `>=` -> `>` | C1 as passwd_app ends exactly the memberships no record explains, expires the vo (+1) | `expect(await stateUnderTestBypass(client, fx)).toEqual(postSta…`: -     "byAt": "EXPIRED", / +     "byAt": "PENDING", |
| C1 departure | 2b boundary | `>=` -> `>` | C1 as passwd_app ends exactly the memberships no record explains, expires the vo (+1) | `expect(await stateUnderTestBypass(client, fx)).toEqual(postSta…`: -     "toAt": "EXPIRED", / +     "toAt": "PENDING", |
| C1 departure | 2c boundary | `>=` -> `>` | C1 as passwd_app ends exactly the memberships no record explains, expires the vo (+1) | `expect(await stateUnderTestBypass(client, fx)).toEqual(postSta…`: -     "toDeletedAt": "EXPIRED", / +     "toDeletedAt": "PENDING", |
| C1 departure | 2b case-insensitive email | `lower()` removed on both sides | C1 as passwd_app ends exactly the memberships no record explains, expires the vo (+1) | `expect(await stateUnderTestBypass(client, fx)).toEqual(postSta…`: -     "toBeforeUpper": "EXPIRED", / +     "toBeforeUpper": "PENDING", |
| C1 departure | 2c email match | email match dropped (JOIN users arm) | C1 as passwd_app ends exactly the memberships no record explains, expires the vo (+1) | `expect(await stateUnderTestBypass(client, fx)).toEqual(postSta…`: -     "toKept": "PENDING", / -     "toNoAudit": "PENDING", |
| C1 departure | 2c case-insensitive email | `lower()` removed on both sides | C1 as passwd_app ends exactly the memberships no record explains, expires the vo (+1) | `expect(await stateUnderTestBypass(client, fx)).toEqual(postSta…`: -     "toDeletedBeforeUpper": "EXPIRED", / +     "toDeletedBeforeUpper": "PENDING", |
| C1 departure | advisory key | `tenant-member:` prefix dropped | the advisory lock of a candidate (tenant, user), key built by the app's helper (+1) | `expect(error?.code).toBe("55P03");`: AssertionError: expected undefined to be '55P03' // Object.is equality |
| C1 departure | lock: advisory candidates | candidate half of the key set removed | C1 as passwd_app ends exactly the memberships no record explains, expires the vo (+16) | `expect(error?.code).toBe("55P03");`: AssertionError: expected '42703' to be '55P03' // Object.is equality |
| C1 departure | lock: advisory 2c subjects | SCIM-subject half of the key set removed | the advisory lock of a 2c subject (SCIM-deleted, no tenant row), key built by th | `expect(error?.code).toBe("55P03");`: AssertionError: expected undefined to be '55P03' // Object.is equality |
| C1 departure | lock: tenant rows | `FOR SHARE OF tmb` removed | a candidate's tenant_members row | `expect(error?.code).toBe("55P03");`: AssertionError: expected undefined to be '55P03' // Object.is equality |
| C1 departure | lock: teams | `teams FOR SHARE` removed | a team row (teams FOR SHARE over all teams) | `expect(error?.code).toBe("55P03");`: AssertionError: expected undefined to be '55P03' // Object.is equality |
| C1 re-key | step 1 | `high_water = 0` dropped | C1 as passwd_app: markers, high-water, ids and history ids are what the literal  (+1) | `expect(await stateUnderTestBypass(client, fx)).toEqual(POST_AP…`: -       "marker": 0, / +       "marker": 1, |
| C1 re-key | step 1 role | role condition removed | migration-superuser: step 1 leaves marker 0, steps 2-4 repair the stragglers, ap (+2) | `expect(await readState(client, fx)).toEqual(POST_STEPS_2_T…`: -       "marker": 0, / +       "marker": 1, |
| C1 re-key | step 2 | history term removed | C1 as passwd_app: markers, high-water, ids and history ids are what the literal  (+4) | `expect(await stateUnderTestBypass(client, fx)).toEqual(POST_AP…`: -       "hw": 3, / +       "hw": 2, |
| C1 re-key | step 2 | attachment term removed | C1 as passwd_app: markers, high-water, ids and history ids are what the literal  (+5) | `expect(await stateUnderTestBypass(client, fx)).toEqual(POST_AP…`: -       "hw": 4, / +       "hw": 2, |
| C1 re-key | step 3 | `item_key_version >= 1` -> `>= 0` | C1 as passwd_app: markers, high-water, ids and history ids are what the literal  (+4) | `expect(await stateUnderTestBypass(client, fx)).toEqual(POST_AP…`: -       "hasId": false, / +       "hasId": true, |
| C1 re-key | step 3 | `item_key_id IS NULL` dropped | C1 as passwd_app: markers, high-water, ids and history ids are what the literal  (+5) | `expect(await stateUnderTestBypass(client, fx)).toEqual(POST_AP…`: -     "appCurrent": "same id", / -     "appHighWaterAbove": "same id", |
| C1 re-key | step 4 | `h.item_key_id IS NULL` dropped | I1: a second run in the same transaction changes nothing | `expect(countsOf(notices, RERUN_REPORT)).toEqual({ marker: 0, h…`: -   "history_ids": 0, / +   "history_ids": 4, |
| C1 re-key | step 4 | `e.item_key_id IS NOT NULL` dropped | I1: a second run in the same transaction changes nothing | `expect(countsOf(notices, RERUN_REPORT)).toEqual({ marker: 0, h…`: -   "history_ids": 0, / +   "history_ids": 1, |
| C1 re-key | teams lock | `teams FOR SHARE` removed | the teams lock held alone makes the block fail on its teams FOR SHARE with 55P03 | `expect(error?.code).toBe("55P03");`: AssertionError: expected undefined to be '55P03' // Object.is equality |
| C6 report | report positive control | removed | raises the control's fixed message when the bypass grant is removed, and passes  | `await expect(runReport(script.replace(grant, ""))).rejects.toThr…`: - Error { / -   "message": "rejected promise", |
| C6 report | report section 1 | C1 exclusion added | section 1 lists exactly the raw candidates with the record flag, and nothing adj (+1) | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -   "f616835b-fd06-4015-9a0e-b325240f25a6": { / -     "has_deactivation_record": true, |
| C6 report | report record flag | logs arm removed | section 1 lists exactly the raw candidates with the record flag, and nothing adj (+2) | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -     "has_deactivation_record": true, / +     "has_deactivation_record": false, |
| C6 report | report record flag | outbox arm removed | section 1 lists exactly the raw candidates with the record flag, and nothing adj (+1) | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -     "has_deactivation_record": true, / +     "has_deactivation_record": false, |
| C6 report | report record flag (logs) | tenant conjunct loosened | section 1 lists exactly the raw candidates with the record flag, and nothing adj | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -     "has_deactivation_record": false, / +     "has_deactivation_record": true, |
| C6 report | report record flag (logs) | action conjunct loosened | section 1 lists exactly the raw candidates with the record flag, and nothing adj | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -     "has_deactivation_record": false, / +     "has_deactivation_record": true, |
| C6 report | report record flag (logs) | target conjunct loosened | section 1 lists exactly the raw candidates with the record flag, and nothing adj | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -     "has_deactivation_record": false, / +     "has_deactivation_record": true, |
| C6 report | report record flag (outbox) | tenant conjunct loosened | section 1 lists exactly the raw candidates with the record flag, and nothing adj | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -     "has_deactivation_record": false, / +     "has_deactivation_record": true, |
| C6 report | report record flag (outbox) | action conjunct loosened | section 1 lists exactly the raw candidates with the record flag, and nothing adj | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -     "has_deactivation_record": false, / +     "has_deactivation_record": true, |
| C6 report | report record flag (outbox) | target conjunct loosened | section 1 lists exactly the raw candidates with the record flag, and nothing adj | `expect(section1Map(w, section1)).toEqual(expectedSection1(w));`: -     "has_deactivation_record": false, / +     "has_deactivation_record": true, |
| C6 report | report section 2 | logs arm removed | a team reached only through a C1-dir record in logs lists all its webhooks; one  (+1) | `expect(inTenants(report.section2, [tenant]).map((r) => r.id)…`: - [ / -   "c8a23ced-f7d6-4a10-9de3-25a770352224", |
| C6 report | report section 2 | outbox arm removed | a team reached only through a C1-dir record in outbox lists all its webhooks; on | `expect(inTenants(report.section2, [tenant]).map((r) => r.id)…`: - [ / -   "db7c4be8-1dad-441f-adc6-03bf48a403e1", |
| C6 report | report section 2 (logs) | action conjunct loosened | a team reached only through a C1-dir record in logs lists all its webhooks; one  | `expect(inTenants(report.section2, [tenant]).map((r) => r.id)…`: +   "18f4338f-d75a-4b34-b183-56f6d03846d7", |
| C6 report | report section 2 (outbox) | action conjunct loosened | a team reached only through a C1-dir record in outbox lists all its webhooks; on | `expect(inTenants(report.section2, [tenant]).map((r) => r.id)…`: +   "6566a7a0-abde-497f-b120-995cedc95676", |
| C6 report | report section 2 | time filter removed | a candidate's team lists only webhooks created or updated after the departure; s | `expect(ids.sort()).toEqual([updated, created].sort());`: +   "e63e5232-77a3-4a3d-a904-971de060b34d", |
| C6 report | report section 2 | time filter: created_at term only | a candidate's team lists only webhooks created or updated after the departure; s | `expect(ids.sort()).toEqual([updated, created].sort());`: -   "c367c432-a24e-49af-9fda-e90008c2aa71", |
| C6 report | report section 2 | time filter: updated_at term only | SURVIVOR (38 passed (38)) | |
| C6 contain | contain guard | team tenant match dropped | the membership belongs to another tenant than the triple's (the user has a depar | `expect(error).not.toBeNull();`: AssertionError: expected null not to be null |
| C6 contain | contain guard | team id match dropped | the team is another team of the tenant, where the user holds no membership | `expect(error).not.toBeNull();`: AssertionError: expected null not to be null |
| C6 contain | contain guard | membership tenant-row tenant match dropped | the tenant row is the user's row in another tenant (departed there, active in th | `expect(error).not.toBeNull();`: AssertionError: expected null not to be null |
| C6 contain | contain guard | active dropped | the membership is already ended | `expect(error).not.toBeNull();`: AssertionError: expected null not to be null |
| C6 contain | contain guard | departed dropped | the tenant row is the user's row in another tenant (departed there, active in th (+2) | `if (expected.message) expect(error!.message).toMatch(expected.…`: AssertionError: expected 'new row for relation "team_members" v…' to match /membership\(s\) qualify .*nothing was…/ |
| C6 contain | contain guard | any-vs-every (`DISTINCT FROM count` -> `= 0`) | a mixed list (one qualifying triple, one not) ends neither | `expect(error).not.toBeNull();`: AssertionError: expected null not to be null |
| C6 contain | contain guard | count check removed | the membership belongs to another tenant than the triple's (the user has a depar (+4) | `expect(error).not.toBeNull();`: AssertionError: expected null not to be null |
| C6 contain | contain inputs | template label check dropped | a label that is the template token | `expect(error).not.toBeNull();`: AssertionError: expected null not to be null |
| C6 contain | contain inputs | 255 bound dropped | a label that is 256 characters | `expect(error).not.toBeNull();`: AssertionError: expected null not to be null |
| C6 contain | contain inputs | array: 2-D check dropped | a three-dimensional array whose second dimension has three entries | `if (expected.message) expect(error!.message).toMatch(expected.…`: AssertionError: expected 'contain: 0 of 1 membership(s) qualify…' to match /two-dimensional uuid array/ |
| C6 contain | contain inputs | array: 3-column check dropped | a two-dimensional array with two columns | `if (expected.message) expect(error!.message).toMatch(expected.…`: AssertionError: expected 'contain: 0 of 1 membership(s) qualify…' to match /two-dimensional uuid array/ |
| C6 contain | contain inputs | array: at-least-one check dropped | SURVIVOR (38 passed (38)) | |
| C6 contain | contain inputs | null-id check removed | a null id in a triple is refused by name, before the qualify count | `if (expected.message) expect(error!.message).toMatch(expected.…`: AssertionError: expected 'contain: 0 of 1 membership(s) qualify…' to match /holds a null id/ |
| C6 contain | contain inputs | dedupe dropped | a duplicated triple counts once and ends the membership |  |
| C6 contain | contain writes | `manual` flag dropped | ends an OWNER and a member at the tenant's stamp with the marker and outbox reco (+4) | `expect(records.get(r.user)).toEqual(buildOutboxPayload({`: -     "manual": true, |
| C6 contain | contain writes | `operator` label replaced by constant | ends an OWNER and a member at the tenant's stamp with the marker and outbox reco (+4) | `expect(records.get(r.user)).toEqual(buildOutboxPayload({`: -     "operator": "ops-test", / +     "operator": "x", |
| C6 contain | contain writes | backfill marker dropped | ends an OWNER and a member at the tenant's stamp with the marker and outbox reco (+4) | `expect([...records.keys()].sort()).toEqual(l.rows.map((r) => r.u…`: - [ / -   "160cdae1-ba70-4d37-a324-3a0b761442d7", |
| C6 contain | contain writes | stamp -> now() | ends an OWNER and a member at the tenant's stamp with the marker and outbox reco (+4) | `expect(after.map((r) => [r.deactivated_at?.getTime(), r.deactiva…`: -     1794321630000, / +     1794328830662, |
| C6 contain | contain writes | `deactivated_by_tenant` false | ends an OWNER and a member at the tenant's stamp with the marker and outbox reco (+4) | `expect(after.map((r) => [r.deactivated_at?.getTime(), r.deactiva…`: -     true, / +     false, |
| C6 contain | contain locks | advisory lock removed | the advisory lock of an input (tenant, user), key built by the app's helper | `expect(error?.code).toBe("55P03");`: AssertionError: expected undefined to be '55P03' // Object.is equality |
| C6 contain | contain locks | tenant rows `FOR UPDATE OF tmb` removed | an input user's tenant_members row | `expect(error?.code).toBe("55P03");`: AssertionError: expected undefined to be '55P03' // Object.is equality |
| C6 contain | contain locks | teams `FOR SHARE` removed | an input team's row | `expect(error?.code).toBe("55P03");`: AssertionError: expected undefined to be '55P03' // Object.is equality |
| C6 contain | contain NOTICE | `session_user` -> constant | ends an OWNER and a member at the tenant's stamp with the marker and outbox reco | `if (notices) expect(notices.some((m) => m === `contain: ended ${…`: - true / + false |

The round-1 runs below cover the controls not re-run in round 2.

#### C1 departure block (review round 1)
| Control | Mutation | Killing cell | Red |
|---|---|---|---|
| bypass grant | `app.bypass_rls 'on'` removed (both blocks) | C1 as passwd_app literal map | `expected { memberships: … } to deeply equal …` (17 failed) |
| restores | each of `bypass_rls`, `bypass_tables`, `purpose`, `tenant_id` restore removed | every `runBlock` (I3 sentinels) | `expected { rls: 'on', … } to deeply equal { rls: 'off', … }` (12–15 failed) |
| role gate | `rolsuper` half dropped | superuser-role skip cell | `expected [] to have a length of 1 but got +0` |
| role gate | `rolbypassrls` half dropped | bypassrls-role skip cell | `expected [] to have a length of 1 but got +0` |
| role gate | inverted | C1 literal map | 16 failed |
| step-1 exclusion | logs arm removed / its tenant, action, target conjunct each loosened | C1 literal map | 2–4 failed each, `expected { memberships: … }` |
| step-1 exclusion | outbox arm removed / its tenant, action, target conjunct each loosened | C1 literal map | 3–4 failed each |
| outbox enqueue | rows filtered out | C1 outbox payload cell | `expected {} to deeply equal { …(8) }` |
| `updated_at` | removed from 2a / 2b / 2c / step 1, each | C1 literal map | `"unchanged"` where `"moved"` expected |
| bypass list | each of 8 tables removed | per-table table-list cells (permanent control) | bypass notice names the table |
| locks | advisory (candidates), advisory (2c subjects), tenant rows, teams, each removed | the matching lock cell (55P03) | (Phase 2 self-check; the cell names the statement that waited) |

#### C1 re-key block (review round 1)
| Control | Mutation | Killing cell | Red |
|---|---|---|---|
| bypass grant | removed | C1 literal map | 10 failed |
| restore | `bypass_rls` restore removed | `runBlock` I3 | `{ rls: 'on' }` vs `{ rls: 'off' }` |
| step 1 | `team_key_version <= 1` → `<= 3` | C1 literal map | 2 failed |
| steps 2 / 3 / 4 | role condition added to each | migration-superuser straggler cell | 3 failed each |
| step 2 | `>` → `<>` | `appHighWaterAbove` | hw expected 5, got 1 |
| step 4 | each of five wrap conjuncts dropped | `differsIn_*` variants | expected null, got the entry's id |
| bypass list | each of 4 tables removed | per-table table-list cells | bypass notice |
| teams lock | removed | re-key teams-lock cell | 55P03 |

### C3 gate (self-test cells; mutants via `MIGRATION_RLS_DML_GATE_UNDER_TEST`)
Review round 2 redesign: 37 mutants, each on a fresh copy of `scripts/checks` with `prisma` and
`node_modules` linked so the real-tree cells run too. Base: the unmutated copy passes all 189 cells.
Each mutant was run with `-t` on its named cell (1–4 cells executed, never 0) and turned it red;
the whole set was re-run independently against the final source by the orchestrator.

| # | Mutation | Named cell | Red |
|---|---|---|---|
| M01 | `\|\|` operand accepted as a literal | dynamic: a DDL literal concatenated with a variable | status 0, expected 1 |
| M02 | `format()` read as a literal | dynamic: format() of a literal | status 0, expected 1 |
| M03 | DYNAMIC findings dropped | dynamic: a variable (and 3 sibling cells) | status 0, expected 1 |
| M04 | any E-string escape accepted | fails closed: E-string octal escape | UNPARSED set `[]`, expected the escape line |
| M05 | `U&` not refused | fails closed: `U&'…'` literal | UNPARSED set `[]`, expected the U& line |
| M06 | single literal not scanned | refuses: EXECUTE of a DML literal | status 0, expected 1 |
| M07 | nested unit starts from a fresh state | passes: grant + literal DML + restore | status 1, expected 0 |
| M08 | nested state frozen at the grant | refuses: EXECUTE of DML after restore | status 0, expected 1 |
| M09 | bypass `set_config` allowed in a literal | fails closed: set_config behind a column default | status 0, expected 1 |
| M10 | non-literal `set_config` name ignored | fails closed: runtime-built name | status 0, expected 1 |
| M11 | E-string `set_config` name accepted | fails closed: E-string name | status 0, expected 1 |
| M12 | `RESET ALL` / odd SET not tracked | fails closed: RESET ALL after a grant | status 0, expected 1 |
| M13 | odd SET refused without a grant | passes: RESET ALL, never granted | status 1, expected 0 |
| M14 | forced-table RENAME in DO not refused | fails closed: RENAME inside a DO | status 0, expected 1 |
| M15 | RENAME refused for any table | passes: RENAME of an unforced table | status 1, expected 0 |
| M16 | nested `bypass_rls` restore accepted | fails closed: restore inside IF | status 0, expected 1 |
| M17 | depth rule dropped | fails closed: grant inside IF | UNPARSED has "not restored", expected the nested-block line |
| M18 | FORCE in a literal accepted | fails closed: FORCE inside an EXECUTE literal | status 0, expected 1 |
| M19 | `DO` in a literal accepted | fails closed: DO inside an EXECUTE literal | status 0, expected 1 |
| M20 | prepared EXECUTE in a literal accepted | fails closed: prepared EXECUTE in a literal | status 0, expected 1 |
| M21 | unterminated `$` quote in a literal ignored | fails closed: unterminated `$` quote | status 0, expected 1 |
| M22 | `WITH … ) TABLE` not a query form | refuses: `WITH … ) TABLE t` | status 0, expected 1 |
| M23 | `IN TABLE` not a query form | refuses: `FOR r IN TABLE t` | status 0, expected 1 |
| M24 | `INSERT … AS a` not skipped | refuses: `INSERT INTO u AS a TABLE t` | status 0, expected 1 |
| M25 | `OVERRIDING … VALUE` not skipped | refuses: `INSERT … OVERRIDING SYSTEM VALUE TABLE t` | status 0, expected 1 |
| M26 | `CURSOR FOR TABLE` not a query form | refuses: `CURSOR FOR TABLE t` | status 0, expected 1 |
| M27 | `FOR TABLE` treated as a reference | passes: LOCK / TRUNCATE / ON / ADD / FOR TABLE | status 1, expected 0 |
| M28 | `sql-scan` identifier class reverted | refuses: top level, fullwidth letter before `$x$` | status 0, expected 1 |
| M29 | `sql-scan` identifier class reverted | refuses: DO body, fullwidth letter before `$x$` | status 0, expected 1 |
| M30 | gate `wordChar` reverted | passes: top level, one fullwidth identifier | status 1, expected 0 |
| M31 | gate `wordChar` reverted | passes: DO body, one fullwidth identifier | status 1, expected 0 |
| M32 | DYNAMIC directories not counted for staleness | baseline entry with a DYNAMIC finding is not stale | stale count 1, expected 0 |
| M33 | `--list` omits DYNAMIC | `--list` prints DYNAMIC before the trailer | stdout lacks the `DYNAMIC: …:3` line |
| M34 | DYNAMIC not checked against the baseline | dynamic: a function call | status 0, expected 1 |
| M35 | `EXECUTE FUNCTION` / `GRANT EXECUTE` counted dynamic | not reported for those or a plain literal | status 1 with `DYNAMIC: …:3`, expected 0 |
| M36 | `\'` and `\\` escapes refused | passes: E-string with only `\'` / `\\` | status 1 (UNPARSED), expected 0 |
| M37 | plain setting names treated as unknown | passes: `SET LOCAL` / `RESET lock_timeout` after a grant | status 1 (UNPARSED), expected 0 |

Rules kept from before round 2 — reference keywords (JOIN, USING, MERGE, INSERT, UPDATE, comma
items), CTE exclusion, nested grant, restore required, exact table-list split, `false`, SET / RESET
in a body, RENAME replay, MERGE ONLY, INSERT … TABLE, UNION ALL TABLE, top-level reading and
materialized view, unterminated quote, FORCE in DO, NO FORCE replay, dollar-quoted literals — were
red-proved in Phase 2 and round 1 against the gate as it then stood; their cells pass unchanged
under the redesign, but those mutants were not re-run after it. The round-1 EXECUTE narrowing
rules (literal mention, multi-statement, CTAS, later literal) were removed with the narrowing.

### Review-verified, not mutant-verified
- `app.tenant_id` set to the nil UUID (both blocks): not killable by a deterministic cell, and
  kept on purpose. Removing it changed nothing observed on a copy, including the two blocks run in
  sequence as `migrate deploy` runs them (the first restores an unset value to `''`) — today's
  executor evaluates the policy's bypass arm first. PostgreSQL leaves the evaluation order of
  subexpressions unspecified, so the tenant arm's `''::uuid` cast could raise under another plan;
  the nil UUID makes it cast cleanly whatever the order (as in `20261109162613`).
- C6 report section 2, `created_at` term of the time filter: equivalent — a webhook created after
  the departure has `updated_at >= created_at`, so the `updated_at` term already admits it.
- C6 contain, the at-least-one-row check: equivalent — an empty array has a NULL `array_ndims`, so
  the two-dimension check already refuses it.
- Lock ORDER in C1 and contain: no deterministic cell distinguishes an order.
