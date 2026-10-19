# Plan Review: bypass-model-grants-and-nesting-fail-closed
Date: 2026-10-19
Review round: 1

## Changes from Previous Round
Initial review. Local-LLM pre-screen: two Minors (C3 grep extensions; D1 downtime wording), applied before expert review.

## User decisions after round 1
- Rollout: observe-then-enforce. This PR ships the policy function in report mode (admit + `RAISE LOG`) and the code that sets the table GUC. A follow-up flips the function to enforce after production shows no report lines. Reason: F2. `deploy.sh`'s compensating rollback, the ECS circuit breaker and the code-only rollback all put old code on the new schema, so a one-release enforcement turns any failed deploy into a sign-in and audit-drain outage.
- Missing-grant detection: a test-time recorder of the tables each bypass transaction's SQL references, asserted against the active grant. No static relation traversal (R5). Production report mode covers the paths tests do not drive.

## Orchestrator probes (dev DB, rolled-back transactions, no objects left behind)
- **T3/F3 confirmed.** An ungranted lookup matching no row returns 0 rows without raising. A matching row raises. The result is never different from a granted read; only detection depends on rows.
- **Report mode.** `RAISE LOG` in the InitPlan form writes one server-log line per statement over a 5000-row scan, to the server log only. `log_min_messages=warning`, and LOG is logged.
- **Prisma 7 + PrismaPg emits `query` events** carrying the SQL text, including relation loads as separate SELECTs and raw SQL. Relation loads are issued only when parent rows exist.

## Functionality Findings (abbrev.; full text in session record)
F1 Critical EXECUTE not granted (default ACL revokes PUBLIC) → total outage; 42501 ambiguity. F2 Critical deploy.sh/circuit-breaker rollback onto enforcing schema. F3 Major refusal row-dependent. F4 Major raw-SQL tables and relation where/_count/nested writes missing from derivation. F5 Major SC2 wrong on RDS (NOSUPERUSER master): SECDEF audit fns and operator scripts subject to C1; auth.ts:557 needs audit_logs. F6 Major forwarder grants (audit-user-lookup) and ALLOWED_VIA. F7 Major worker table sets under-derived/misstated; granularity. F8 Major Prisma.dmmf denied by check-raw-sql-usage. F9 Major C5 overclaim (swallowed outer). F10 Minor key-rotation scenario wrong. F11 Minor counts. F12 Minor non-RLS exclusion unnecessary; delimiter. F13 Minor [Adjacent] 21 integration files set bypass directly.

## Security Findings (abbrev.)
SECURITY R1 (probes in rolled-back tx; zz_* cleaned)
S1 Major C1 "enforceable boundary" overstated: GUC writable in-band (set_config app.bypass_tables widened read), raw SQL, cascades, SECDEF, non-RLS -> reclass "fail-closed runtime guard vs honest code"; list escapes; true boundary = per-grant login role (rejected alt)
S2 Major gate only set_config('app.bypass_rls'; need AST decoded-literal gate for any "app.bypass_" text outside grants file; deny session-level writes (set_config 3rd arg not true, SET w/o LOCAL); runtime tamper re-read after callback
S3 Major forbidden regex matches nothing; add rls-smoke catalog assertion: every policy qual/with_check contains rls_bypass_admits('<own table>') and no app.bypass_rls; negative block per table; red-prove
S4 Major exact element equality (= ANY string_to_array, no trim); acceptance: delegation_sessions grant !admit sessions; service_accounts !admit accounts
S5 Major migration REVOKE PUBLIC + GRANT EXECUTE to passwd_app, outbox_worker, retention_gc_worker, anchor_publisher, dcr_cleanup_worker; regenerate db-grants-manifest; E3 RDS default ACL
S6 Major(prose) SC2 SECDEF audit_log_purge/audit_log_tenant_migrate are app-reachable (auth.ts:557, purge route, sweep.ts:448) — outside C1 for audit_logs; [Adj] require context
S7 Major FK cascades reach ungranted tables (probed); restate invariant incl cascade closure; C4 prints closure
S8 Major C5 rollback undoes security-tightening writes (lockout, revocation, replay revoke, in-tx audit) — enumerate & assert no nested-capable side effect inside; key-rotation scenario wrong (invalidateUserSessions runs outside context)
S9 Major 42501 swallowed by invalidateUserSessions .catch -> sessions survive; derive its grant from token-model enumeration; integration test all token models; alert log on 42501 in best-effort security catches; enumerate catch sites
S10 Major D1 note: audit rows lost (enqueueAudit fails, swallowed), sign-in fails; maintenance window default
S11 Minor withTenantRls pin bypass_rls off + bypass_tables ''
S12 Minor SET search_path = pg_catalog, pg_temp; no LEAKPROOF; non-SECDEF
S13 Minor non-RLS list add 2 m2m tables (derive from pg_class); counts 224/98
S14 [Adj] Major tenants no RLS full DML — note in C7, follow-up
S15 [Adj] Major pg_db_role_setting not audited — ROLESETTING manifest rows

## Testing Findings (abbrev.)
TESTING R1
T1 Critical e2e job app runs as superuser ci → E2E under C1 vacuous; cookies injected; adapter getSessionAndUser (every request, nested user select under bypass) untested → NOSUPERUSER e2e role w/ assertion, or integration tests per adapter method as passwd_app
T2 Critical 66/98 bypass files (124/224 calls) not imported by any integration test; per-grant evidence table; test-only query recorder ($on query / extension) diff (purpose,table) vs grants
T3 Major InitPlan only runs when a row is examined → ungranted lookup with no matching row returns empty (hypothesis) → acceptance cell; restate R1; seeding requirement
T4 Critical no test pins own-table literal / InitPlan form; system_settings excluded from Block 4 → [E-RLS-BYPASS-TABLE] assertion; leave-one-out negative per table; negative-test.sh mutations (wrong literal, old COALESCE, bare call, returns false, returns true)
T5 Major breaking set incomplete: 14 unit files; retention-gc-tx-fakes regex; 52 test files BYPASS_PURPOSE; ~25 vi.mock tenant-rls factories w/o importOriginal → say which module exports BYPASS_GRANT; 46 inline integration GUC sets in 20 files + ~100 setBypassRlsGucs callers (required vs optional tables arg); fixtures 209/45; check-rls-read-context.mjs:266-304 hardcodes setBypassRlsGucs/set_config; check-bypass-rls RAW_BYPASS_GUC_RE:2242
T6 Major PUBLIC EXECUTE (default) adds FUNCTION rows → post-migrate audit-db-grants (ecs.tf:289) fails; regen manifest; deploy note   [conflict w/ S5: dev default ACL revokes PUBLIC? → explicit REVOKE+GRANT resolves both]
T7 Major RDS master NOSUPERUSER NOBYPASSRLS → C1 applies to tenant-domain + migrate scripts on RDS; reword SC2; tests as passwd_app
T8 Major C5 wrong swallow sites; notification/webhook detached; mocks don't roll back; integration cells: 4 combos, fn-throws precedence, no flag leak to sibling tx, detached known-limit commits; side-effect row assertions
T9 Major worker fake models only bypass_rls/purpose; per-worker mutation (remove one table → red) as own role; registry table-driven test
T10 Major fixture copies real tenant-rls.ts → imports grants (dmmf) → copy real grants + dmmf stub; grant spelling cases (inline literal, alias, conditional, param-forwarded, spread, cast, renamed import); real-repo every grant used; mutation
T11 Major ci-integration path filter add tenant-rls-grants.ts; job per test
T12 Major named mutations per contract; isolated Postgres for migration mutations
T13 Minor unset-GUC cell as D1 stand-in; readiness doesn't see window
T14 Minor EXPLAIN JSON InitPlan assertion
T15 Minor counts 224/98 (~221); grep -v '\.test\.\|__tests__/'

## Adjacent Findings
S14 (tenants has no RLS; all tenant security policy, full app DML) and S15 (role/database GUC defaults unaudited) are routed to follow-up issues (plan SC6, SC7). F13 is merged into T5.

## Quality Warnings
None. Every finding carries file evidence or a probe.

## Recurring Issue Check

### Functionality expert
- R1: F4/F3 — plan's grep re-does the existing check-required-user-relation traversal with less coverage. R2: F12. R3: F6 (ALLOWED_VIA), F7. R4: N/A. R5: OK (C5 in-tx). R6: checked — cascades bypass RLS (probe). R7–R8: N/A. R9: F9 (best-effort outer). R10–R13: N/A. R14: F1. R15: OK (migration generated from pg_policies). R16: F5. R17: F6. R18: F8, F1 (manifest). R19: F13 (adjacent). R20–R21: N/A. R22: F5 ("superuser" assumption). R23: N/A. R24: F2 (enforcement + code in one release). R25–R28: N/A. R29: F7, F10, F11; D3 42501 evidence ambiguous (F1). R30–R31: N/A. R32: F2 (health/readiness). R33: F13. R34: N/A. R35: F2 (no rollback test plan). R36–R39: N/A. R40: F12. R41: F3. R42: F4, F6, F7, F11. R43–R46: N/A. R47: F4 (grep enumeration). R48: F6. R49: F9, F3. R50: F1 (permission error satisfies "raises 42501"). R51: N/A. R52: F5. R53: N/A. R54: OK (GUCs tx-local). R55–R57: N/A.

### Security expert
- R1–R13: N/A for plan shape. R14: S5. R15: N/A. R16: S5 (RDS default ACL). R17–R28: N/A. R29: S6, S8 (wrong scenario), S13 (counts). R30–R41: N/A. R42: S6, S13. R43: S8. R44–R46: N/A. R47: S2, S3. R48: N/A. R49: S1, S7. R50–R53: N/A. R54: S1, S2, S11. R55–R57: N/A.
- RS1–RS6: N/A (no new routes/input/crypto; messages carry only a literal table name).

### Testing expert
- R1–R2: n/a. R3: T5 (gate spelling tied to setBypassRlsGucs/set_config). R4–R13: n/a. R14: T6 (FUNCTION EXECUTE manifest). R15: n/a. R16: T1 (e2e role ≠ prod), T7 (RDS principal). R17: T5 (helper adoption). R18: T11 (CI path allowlist). R19: T5 (~25 tenant-rls mock factories). R20–R21: n/a. R22: checked — C5 inverts the existing swallow test, plan handles it. R23–R28: n/a. R29: T15, T8 (rotate-key scenario). R30–R34: n/a. R35: T13 (deploy note only). R36–R41: n/a. R42: T5, T2. R43–R46: n/a. R47: T10 (grant spellings). R48: n/a. R49: T3. R50: T1 (superuser makes E2E vacuous). R51: n/a. R52: T5 (check-rls-read-context reach after rename). R53–R57: n/a.
- RS1–RS6: n/a (out of scope). RT1: T9 (worker GUC fake), T8 (passthrough mocks). RT2: checked. RT3–RT4: n/a. RT5: T1, T8. RT6: T10. RT7: T4, T12. RT8: T8. RT9: T10. RT10: T8 (flag-leak allow cell). RT11: n/a (probe rolled back and verified).

# Round 2

## Changes from Round 1
Plan rewritten for report-then-enforce rollout and a test-time recorder; C1 privileges, exact membership, own-table assertions; control class restated; worker/forwarder/ALLOWED_VIA grants; C5 scope and limits.

## Orchestrator probes
- pg Pool `options: '-c client_min_messages=log'` delivers RAISE LOG to a `notice` listener; without the option nothing is delivered.

## Functionality Findings (abbrev.)
FUNC R2 probes: IMMUTABLE flag fn replace takes effect for prepared/generic plans; concurrent CREATE OR REPLACE serializes on pg_proc tuple lock; counts 226/57/26 reproduced.
F7 cont Major outbox per-transaction grants: drain + audit_deliveries, audit_delivery_targets, webhook_deliveries, tenants; deliveries/webhooks + audit_outbox, audit_logs; reaper/purgeRetention/recordError/writeDirectAuditLogBestEffort/readOutboxDepth own grants
N1 Major in-tx swap infeasible → CI superuser step commits enforce; local separate DB; report-mode cells on unflipped DB; rls-smoke flip as superuser step
N2 Major recorder: use DB notices (client_min_messages=log + notice listener), table+purpose in message, no ALS correlation
N3 Major prod observability: RDS export+metric, or app-side notice handler → structured rls.bypass_not_granted log via existing pipeline
N4 Major readers (audit-outbox-in-tx.ts:35, audit-outbox.ts:59, sweep.ts:129,192, audit-outbox-worker.ts:93-94, assert-bypass-rls-active.ts:45,50) → writer-only rule or readBypassState helper
N5 Major C5 member set: derive from schema (token/credential/lockout models incl accountLockedUntil/lastFailedUnlockAt, session deletes, enqueueAuditInTx, revokeFamilyOutOfBand), callers via AST
N6 Minor line counts (per table x policy expr; 0 if no row)
N7 Minor quiet window can't evidence rare paths; rollback log volume
N8 Minor invoker trigger bodies as grant source (users→tenant_members)
N9 Minor tenants in worker/anchor/retention grants; drop audit_outbox from anchor; setBypassGucs tenantId param

## Security Findings (abbrev.)
SECURITY R2: resolved S1 S3 S4 S5 S6 S7 S10 S12 S13; routed S14 S15; partial S2 S8; dropped S9→N5, S11→N6. Mode switch ownership OK (no CREATE on public; policy binds OID).
N1 Major enforce swap cannot reach passwd_app pool (separate session can't see uncommitted DDL) → allow cells vacuous / temptation to commit; negative-test mutating real function leaks → mechanism (a) same-connection superuser BEGIN; CREATE OR REPLACE; SET LOCAL ROLE; run with tx client; ROLLBACK, or (b) dedicated test DB guarded by current_database(); assert enforced() true in cell, false afterAll fresh conn; negative-test uses throwaway function; gate: no CREATE OR REPLACE of these outside migrations+helper
N2 Major report log not collected in prod (no RDS log export, no metric) → SC5 window unobservable; add CloudWatch export + metric filter + alarm + verify, or demote wording & SC5 depends on export
N3 Major C4 writer gate spelling: case-insensitive APP.BYPASS_RLS, quoted "app"."bypass_rls", spaced, concatenation, 't'::boolean; readers outside grants file → name-independent rule: any set_config / SET/RESET/ALTER..SET outside tenant-rls.ts+grants fails; allowlist 2 lock_timeout sites (account-lockout.ts:222, audit-outbox-worker.ts:350); readBypassGucs helper; optional runtime re-read of bypass_tables after fn
N4 Minor R2 'exactly one line' false (self-join 2, no-row 0); 'every' overstated
N5 Major S9 invalidateUserSessions not in SC5 preconditions → integration cell all token models under enforce; error-level log at best-effort revocation catch sites
N6 Minor withTenantRls pin bypass_rls off / bypass_tables '' or record decision
N7 Minor schema-qualify public.rls_bypass_enforced() (search_path pg_catalog,pg_temp)
N8 Minor RAISE LOG purpose unbounded/unescaped → newline forges; sanitize ^[A-Z0-9_]+$ else <invalid> (note: purposes are lowercase values e.g. auth_flow → use ^[a-z0-9_-]+$)
N9 Minor C5 grep misses delete-style revocations → derive from token models × delete|deleteMany|updateMany
N10 Minor C8 rewrite existing 'nothing at runtime checks' lines to mode-accurate wording

## Testing Findings (abbrev.)
TESTING R2: resolved T1 T3 T5 T6 T8 T10 T11 T14 T15 (counts 229-3=226; outbox 27 lines = def+26); T2 not resolved; partial T4 T7 T9 T12; T13 design.
Probe: CREATE OR REPLACE of IMMUTABLE flag fn takes effect immediately in-session even after plpgsql cached plan. client_min_messages=log as passwd_app delivers LOG to client (notice). Line counts: UPDATE 2, SELECT 1, INSERT 1, DELETE 0 rows (seqscan) 1.
N1 Critical recorder attach point emits no events (global prisma log:['error']; helpers no log; Prisma 7.10 emits only if logQueries); ALS has no grant; C3 paths have no ALS store → patch pg.Client.prototype.query in setup; track grant per connection from set_config('app.bypass_tables',$1) param; clear on COMMIT/ROLLBACK
N2 Major text parser: CTE names false-red; schema-qualified; comma join/USING; triggers invisible (users insert trigger -> tenant_members, invoker) → intersect pg_class, remove WITH names; or rely on enforce-mode integration as authoritative
N3 Major listener throw swallowed by best-effort catches → buffer + afterEach + file sink per process + global teardown aggregate
N4 Critical in-tx enforce swap impossible in verify.sql (passwd_app, E-RLS-ROLE) and for production-driven cells → CI step as passwd_user commits enforced()=true before rls-smoke verify & before an enforce-mode integration pass (ephemeral DB); assert shipped migration returns false; local only on scratch DB
N5 Major log assertion mechanism: SET client_min_messages=log + pg notice listener / connection option; psql stderr; R2 restate (per policy expression); assert presence not count
N6 Major RDS logs not exported → E5; CloudWatch export or manual procedure as SC5 precondition; metric filter
N7 Major E3 definer NOSUPERUSER-owner cell missing
N8 Major scratch DB procedure: createdb; apply initdb 02-04; migrate deploy; rls-smoke seeds; base green; drop in trap; record current_database()
N9 Major assert message prefix RLS_BYPASS_NOT_GRANTED: <table>, not SQLSTATE
N10 Major map each mutation to test; recorder mutation
N11 Major registry/worker tests must use production grant derivation (export pure entry→grant fn; drive phase functions)
N12 Minor negative-test.sh canonical & Case2 policies; grep include *.sh *.sql
N13 Minor derive evidence table from sinks; name no-row cell

## Resolution (plan revision 3)
- Recorder replaced by DB-adjudicated notice capture (func N2, test N1/N2/N3, sec none): `client_min_messages=log` pool option + notice listener; buffer + afterEach + per-process sink; the same listener feeds production structured logs (func N3, sec N2, test N6) and a CloudWatch metric filter in monitoring.tf.
- Enforce evidence via a committed superuser flip on CI's ephemeral DBs and a documented scratch-DB procedure (func N1, sec N1, test N4/N8); shipped-false assertion; no CREATE OR REPLACE outside migrations and the flip step; negative-test mutations on a throwaway function.
- Writer rule name-independent; readers behind `readBypassState` (sec N3, func N4).
- Outbox grants per transaction function; tenants added; anchor drops audit_outbox; `setBypassGucs` takes tenantId; `grantForEntry` exported (func F7/N9, test N11).
- C5 state-tightening member set derived from schema models (func N5, sec N9).
- R2 restated with probed counts (sec N4, func N6, test N5); purpose sanitized in the log line (sec N8); `public.` qualification (sec N7); withTenantRls pins bypass off (sec N6).
- SC5 preconditions: metric 0 with pipeline verified, per-grant evidence or reviewed gap, invalidateUserSessions enforce cell + error-level logging (sec N5, func N7).
- Definer cell under NOBYPASSRLS owner (test N7); prefix-matched refusals (test N9); mutation → red-test table (test N10); negative-test.sh canonical/Case 2 (test N12); evidence table derived from sinks, no-row cell named (test N13); E5 added.

# Round 3

## Orchestrator probe
- `RAISE WARNING` reaches a pg `notice` listener at default `client_min_messages`; `where` = "PL/pgSQL function …rls_bypass_admits(text) line 1 at RAISE".

## Findings (abbrev.)
SEC R3: N1 N4-N10 resolved; N2 partial; N3 in principle.
S3-1 Major client_min_messages=log ships log_statement/duration/auto_explain text+bind params to app → RAISE WARNING, drop option; listener accepts only severity+where+full regex, drops rest silently; unit test synthetic secret notice → zero logger calls; bound rate map
S3-2 Major scratch DB: OUTBOX_WORKER_DATABASE_URL etc + .env.local override → dev DB; flip/drop unguarded; name guard impossible → COMMENT ON DATABASE marker 'passwd-sso:ephemeral-rls-enforce' checked in flip tx, drop, and per-connection harness assert; export all *_DATABASE_URL; refuse if .env.local overrides
S3-3 Major SC5 metric: one filter per log group (app, outbox, retention) on $.event; positive canary per group; script pools need listener; migrate-webhook-secrets cell or gap
S3-4 Major writer spellings: "set_config", pg_catalog.set_config, whitespace/comment before paren, U& ident, DO/EXECUTE concat → reject DO/EXECUTE too; constant-fold; reword 'cannot evade'
S3-5 Minor lock_timeout: exact statement or setLockTimeout helper
S3-6 Minor manual-tests/mcp-replay-audit-verification.ts writer
S3-7 Minor post-condition grep 477 lines
S3-8 Minor C8 qualifiers; SC5 precondition prod & rollback target ≥ this release; threat-model.md:93,95
FUNC R3: F7 N1 N2-N6 N8 N9 resolved; N7 partial.
RP3-1 Major ci-integration migrates before creating passwd_app → IF EXISTS grant skipped → all fail; grant in bootstrap step + bootstrap-rds-roles.mjs (guarded by to_regprocedure); setup assertion has_function_privilege per role
RP3-2 Major listener misses script pools (tenant-domain:189, migrate-account-tokens:109, migrate-webhook-secrets:239, manual-test:36) → one pool factory + gate rejecting direct construction
RP3-3 Major singleton sink not routed to test buffer → process-level sink registry resolved at notice time; mutation 'production sink only'
RP3-4 Major URL options override pool options (probed); LOG traffic leak → set tx-locally or (sec) RAISE WARNING
RP3-5 Major enforce pass mode selection: RLS_BYPASS_MODE env; setup asserts enforced() matches; teardown asserts enforce cells executed > 0
RP3-6 Minor enforce mode also emit notice before raise
RP3-7 Major writer rule / post-condition match UPDATE..SET (79 lines/26 files) → SQL lexer statement-leading SET/RESET/ALTER..SET + set_config identifier token
RP3-8 Minor rollback log volume claim wrong (RDS server log, unrated); DROP WITH (FORCE); seeds step
RP3-9 Minor no-CREATE-OR-REPLACE rule needs mechanism
TESTING R3: T3-1 Critical test sink unreachable from singleton/worker pools; T3-2 pass selector; T3-3 evidence needs positive records; T3-4 scratch DB leaks to dev / unguarded flip; T3-5 negative-test mutations caught by catalog block first; T3-6 metric filter vs _logType, per log group, existing filters dead (ADJ); T3-7 listener member set (script clients); T3-8 purpose sanitisation tested on JS layer; T3-9 script cells run as superuser; T3-10 seed-what-you-read circular; T3-11 system_settings unseeded; T3-12 old-code cell / deploy note assume listener; T3-13 options override; T3-14 late notices; T3-15 CI plumbing; T3-16 flip copies; T3-17 pre-pr whitelist; T3-18 presence not count; T3-19 OR-arm order.

## User decision after round 3
Round 3's findings sit almost entirely in the enforce-test machinery Round 2 added (enforce rerun, evidence table, scratch DB, flip plumbing) — a round seeding its own defects. Re-scoped: this PR is report mode plus its observation channel; everything only enforcement needs moves to SC5's preconditions.

## Resolution (plan revision 4)
- RAISE WARNING, no pool option (S3-1, RP3-4, T3-13); listener accepts severity+where+full regex, drops the rest silently, unit-tested with a synthetic secret notice; bounded rate map.
- EXECUTE granted in ci-integration bootstrap and bootstrap-rds-roles.mjs; setup asserts has_function_privilege (RP3-1).
- Pool factory as the only constructor, AST pool rule; process-level sink registry resolved at notice time; positive control per attach point (RP3-2/3, T3-1, T3-7, S3-3 scripts).
- Writer rule: SQL lexer, statement-leading SET/RESET/ALTER..SET, DO, EXECUTE, set_config tokens incl. quoted/qualified/U&; constant folding; wording narrowed (S3-4, RP3-7, S3-7); setLockTimeout helper (S3-5); manual-test writer moved (S3-6); function rule (RP3-9, T3-16).
- WARNING also before the enforce raise (RP3-6); DB-side sanitisation cell (T3-8); old-code cell without listener, deploy note corrected (T3-12, RP3-8); system_settings seeded, report block after Block 4, pre-pr whitelist (T3-11, T3-17); negative-test mutations expect the catalog code (T3-5); _logType-based filter per log group + pattern test (T3-6, S3-3); C8 qualifiers and threat-model lines (S3-8); presence assertions (T3-18); late-notice drain (T3-14).
- Moved to SC5: T3-2, T3-3, T3-4/S3-2, T3-9, T3-10, T3-15 (enforce parts), T3-19, RP3-5, S3-3 canary, S3-8 release precondition. Adjacent dead filters → SC8.

# Round 4

## Findings
- **Functionality:** RP3-1..9 resolved or moved to SC5. F1 Major (design): the integration harness pools bypass the factory. F2 Minor (a): observe `rls.nesting_refused` before C5 ships. F3 Minor (a): 200-char purpose wording. Probes: all 57 policies are FOR ALL PERMISSIVE with the bypass arm first; a bypass-only policy plans as a per-row `Filter: $0`.
- **Security:** S3-1..8 resolved or moved. The WARNING-traffic sweep is clean (no data-bearing RAISE in DB functions; Prisma adapter has no notice handler). No Critical/Major. Minors: S4-1 EXECUTE on `rls_bypass_enforced()` (probed: a missing grant turns report into refusal); S4-2 CREATE FUNCTION … SET / `$$` bodies; S4-3 D4 overclaim (URL/PGOPTIONS/role can suppress WARNING); S4-4 listener digits regex, `new Client` in the pool rule.
- **Testing:** T3 items resolved or moved, except T3-1, which continues as T4-1 Critical (design; same as F1). T4-2 Major: positive controls trip the worker guard. T4-3 Major: no stderr runner for rls-smoke WARNINGs. T4-4 Major: production sink routing untested. T4-5/6 Minor prose; T4-6 is refuted by the func/sec probes (per-row Filter). T4-7 Minor (b): E5 raw line and per-group filter count. RT8 note: C5 cells assert the rolled-back row is absent.

## Resolution (plan revision 4.1)
All findings were applied as local corrections; no new machinery:
- harness pools via the factory, pool rule over db-integration, `ctx.app` positive control;
- worker attach points covered by the AST rule, with no guarded `application_name` in cells;
- `rls-verify-run.sh` used by all three runners;
- registry default = production sink, plus sink-routing units;
- sanitisation cells clarified;
- E5 raw-line and per-group filter assertions;
- the C5 absent-row assertion;
- S4-1..4;
- the F2 deploy-note step.

# Round 5 (saturation check, combined reviewer)
- All Round-4 findings resolved in rev 4.1; T4-6 not reopened (refuted).
- No Critical/Major in any perspective. Minors: R5-M1 (testing, design, b: negative-test cases pre-empted by the new Block 1 assertion), R5-M2 (functionality, prose, b: pool/function rule allowlists vs real sites), R5-M3 (security, prose, a: createPool options refusal untested; URL/PGOPTIONS). All three applied in the plan.

## Saturation call
Round 5: ≥2 rounds completed; no open Critical/Major; no remaining finding against the design; remaining Minors were applied. Plan saturated. All contracts C1–C8 locked. No carried-forward findings.
