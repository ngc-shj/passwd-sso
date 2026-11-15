# Code Review: rls-refusal-metric
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review (incremental over the Phase 2 self-R-check; Ollama unavailable, so no seed findings and a manual merge).

## Functionality Findings
- **F-1 [Minor]** `docs/security/security-review.md` residual-risk bullet named only `rls.bypass_not_granted` (R3).
- **F-2 [Minor]** (converged with Security F4) plan C1 known gap (a) — a refusal caught in SQL by a handler that does not re-raise never reaches the client — was missing from alerts.md, the boundary matrix and security-review's "Not covered" list; "the error is always delivered" stood unqualified (R49).
- **F-3 [Minor]** (converged with Testing T-3) `resetListenerSupportProbe` exported with no caller, contradicting plan C1 (RT6).
- **F-4 [Minor]** (converged with Security F3) alerts.md's refusal-without-warning diagnosis checked only `pg_db_role_setting`; a server-level source or a runtime `SET` gives the same symptom.
- **F-5 [Minor]** missing space after a comma in the new allowlist entry.

## Security Findings
- **F1 [Major]** `LOG_LEVEL` above `warn` (`error`, `fatal`, `silent`, all accepted by the env schema) makes pino drop all three RLS lines without throwing, so the metric reads zero — the same "setting changed between deploys" class as #1048, in a pre-existing path of a touched file (R34). Docs overstated the guarantee.
- **F2 [Minor]** pg-pool runs `onConnect` before it emits `connect`, so queries there precede the listeners; `checkedConfig` did not refuse it (R42 member missed by the `Client`/`native` set).
- **F3 [Minor]** see F-4.
- **F4 [Minor]** see F-2.
- **F5 [Minor]** the gate's file docblock still described `POOL_RULE_ALLOWLIST` as superuser/no-bypass only (R3).

## Testing Findings
- **T-1 [Minor]** the "non-string hint" / "missing message" cells could not fail for the `typeof` guards: `RegExp.exec` coerces `42` and `undefined` to non-matching strings (RT7; verified by scratch mutation).
- **T-2 [Minor]** `withClient` released the connection without `ROLLBACK` on the failure path, so a failing cell would hand the `max: 1` pool an aborted transaction with `SET LOCAL` in force (RT11).
- **T-3 [Minor]** see F-3.
- **T-4 [Minor]** a pre-existing `process.stderr.write` spy in `pool-factory.test.ts` was restored outside `finally`.

## Adjacent Findings
None.

## Quality Warnings
None. Every finding carried a file/line and, where behavioural, an executed reproduction.

## Recurring Issue Check
### Functionality expert
R1 Checked · R2 Checked · R3 F-1 · R4–R9 N/A · R10 Checked · R11 N/A · R12 Checked · R13–R15 N/A · R16 Checked · R17 Checked · R18 Checked (F-5 formatting) · R19 Checked · R20 N/A · R21 Checked · R22 Checked · R23–R31 N/A · R32 N/A · R33 N/A · R34 Checked · R35 Checked · R36 Checked · R37 N/A · R38 Checked · R39 N/A · R40 Checked · R41 Checked · R42 Checked · R43–R46 N/A · R47 Checked · R48 Checked · R49 F-2 · R50 Checked · R51 N/A · R52 Checked · R53–R54 N/A · R55 Checked · R56–R57 N/A

### Security expert
R1 OK · R2 OK · R3 F5 · R4 OK · R5–R15 N/A · R16 OK · R17 OK · R18 OK · R19 OK · R20–R28 N/A · R29 checked (F1, F4 doc claims) · R30 OK · R31–R33 N/A · R34 F1 · R35 OK · R36 OK · R37 N/A · R38 OK · R39–R41 N/A · R42 F2 · R43–R46 N/A · R47 OK · R48 OK · R49 F1, F4 · R50 OK · R51–R57 N/A · RS1 N/A · RS2 OK · RS3 OK · RS4 OK · RS5 N/A · RS6 OK

### Testing expert
R3 OK · R19 OK · R33 OK (integration paths-filter covers the touched paths) · R49 T-3 · other R rules N/A or out of scope · RT1 OK · RT2 OK · RT3 OK · RT4 N/A · RT5 OK · RT6 OK (T-3) · RT7 T-1 · RT8 OK · RT9 N/A · RT10 OK · RT11 T-2

## Environment Verification Report
- V1 (no real AWS): the per-log-group production canary and the `terraform apply` of the new filter are `blocked-deferred`, linked to plan constraint V1 and scope item SC2 (owner: #921's attestation checklist); procedure in `rls-refusal-metric-manual-test.md`. Offline evidence `verified-local`: `terraform validate`, mocked root `terraform test` 27/27 with the run-count check, A4 cells matching both sinks' lines (and the stderr fallback under LOG_LEVEL above warn) against the filter patterns read from `monitoring.tf`.
- V2 (worktree DB): A5/A6/A8 `verified-local` on `passwd_sso_wt_1048` (enforcing): `npx vitest run -c vitest.integration.config.ts` over the changed integration files and every other `expectBypassRefusal` caller, exit 0. Four unrelated files fail identically on main against the same database (deviation D5).

## Resolution Status
### F1 [Major] LOG_LEVEL above warn silences the RLS lines
- Action: `warnReportLine` writes each report line through the logger when warn is enabled, and straight to stderr as the same JSON line otherwise; alerts.md and the boundary matrix say so. New cells in `pool-factory.metric-filter.test.ts` set the real pino logger to `error`, `fatal` and `silent` and match each kind's stderr line against its filter, plus an allow cell at `warn` (logger, no stderr). Red-proof: disabling the fallback reddens the three level cells (exit 1; control exit 0).
- Modified file: `src/lib/db/pool-factory.ts` (`warnReportLine`), `src/lib/db/pool-factory.metric-filter.test.ts`, `docs/operations/alerts.md`, `docs/security/tenant-boundary-matrix.md`.
### F2 [Minor] onConnect precedes the listeners
- Action: `checkedConfig` refuses `onConnect` with `Client` and `native`; probe cells for the refusal and for `undefined` values accepted. Red-proof: removing `onConnect` from the list reddens its cell.
- Modified file: `src/lib/db/pool-factory.ts` (`checkedConfig`), `src/lib/db/pool-factory.probe.test.ts`.
### F-1 / F-2 / F4 / F-4 / F3 / F5 / F-5 [Minor] docs and comments
- Action: security-review names both lines and lists the SQL-handler gap with its `pg_proc` member query; alerts.md and the matrix qualify "always delivered"; the diagnosis uses `pg_settings.source` and covers a runtime `SET`; gate docblock and allowlist formatting fixed.
- Modified file: `docs/security/security-review.md`, `docs/security/tenant-boundary-matrix.md`, `docs/operations/alerts.md`, `scripts/checks/check-bypass-rls.mjs`.
### F-3 / T-3 [Minor] unused probe seam
- Action: `resetListenerSupportProbe` removed; plan C1 says the A7 cells isolate the memo with `vi.resetModules()`.
- Modified file: `src/lib/db/pool-factory.ts`, plan.
### T-1 [Minor] typeof guards untestable by coercing values
- Action: cells use objects whose `toString` would match (`{ toString: () => "bypass purpose auth_flow" }`, same for the message). Red-proof: dropping each `typeof` guard reddens only its own cell.
- Modified file: `src/lib/db/pool-factory.test.ts`.
### T-2 [Minor] failure-path release without ROLLBACK
- Action: `withClient` runs `ROLLBACK` (errors ignored) before `release()`; the post-ROLLBACK baseline check stays inside the cell.
- Modified file: `src/__tests__/db-integration/rls-bypass-refusal-count.integration.test.ts`.
### T-4 [Minor] stderr spy restored outside finally
- Action: wrapped in `try/finally`.
- Modified file: `src/lib/db/pool-factory.test.ts`.

---

# Round 2
Date: 2026-11-16

## Changes from Previous Round
Round-1 fixes (124b44c43) verified by all three experts; no regressions, no boundary widening (R43: the stderr fallback writes only the regex-bounded `table`/`purpose` and the fixed `_logType`, to the same log group, and leaves the default level unchanged).

## Findings
- **Functionality G-1 [Major]** alerts.md's `pg_settings.source` diagnosis was wrong in two places, shown by a three-connection probe on the worktree DB: a `session` source is visible only inside the session that ran the `SET` (another connection reads `default`), and `client` (startup options) was filed under "server-level". (Security N1 [Minor] reported the `client` half.)
- **Functionality G-2 [Minor]** `silent` was described as accepted by the env schema; `LOG_LEVEL` is `trace`..`fatal`.
- **Security [Adjacent → testing]** the LOG_LEVEL cell asserted "nothing went through the logger" only after the last emission.
- **Testing**: No findings (own red-proof of the undefined-keys allow cell: `name in fields` reddens only that cell).

## Resolution Status
### G-1 / N1 [Major] pg_settings.source mapping
- Action: the alerts.md paragraph maps each documented source value: `user`/`database`/`database user` → role or database setting; `client` → startup options (the service's pools refuse them, so the operator's own psql); `configuration file`/`command line`/`environment variable`/`global` → server level; `default` → no persistent setting, the remaining cause a runtime `SET` in service code, invisible from another session, found by searching the code.
- Modified file: docs/operations/alerts.md.
### G-2 [Minor] silent and the env schema
- Action: code comment, test comment and alerts.md say error/fatal are the schema's values above warn and pino's silent takes the same path; the silent cell is kept.
- Modified file: src/lib/db/pool-factory.ts, src/lib/db/pool-factory.metric-filter.test.ts, docs/operations/alerts.md.
### Adjacent [Minor] per-emission logger check
- Action: `stderrLines` asserts nothing went through the logger after each emission at a level above warn.
- Modified file: src/lib/db/pool-factory.metric-filter.test.ts.

---

# Round 3
Date: 2026-11-16

## Findings
- Security: No findings (R43: source change is comment-only; `warnReportLine` byte-identical).
- Testing: see below.
- **Functionality H-1 [Major]** the round-2 mapping filed `global` as server-level; `PGC_S_GLOBAL` is the `pg_db_role_setting` row with `setdatabase = 0, setrole = 0` (`ALTER ROLE ALL SET`), applied in `postinit.c` `process_settings()`.

## Resolution Status
### H-1 [Major] `global` is a catalog setting
- Action: `global` moved into the catalog bullet (`ALTER ROLE ALL SET`, listed in `pg_db_role_setting`); the server-level bullet keeps `configuration file`, `command line`, `environment variable`; the operator's own `session` added.
- Modified file: docs/operations/alerts.md.

---

# Round 4
Date: 2026-11-16

## Findings
- Functionality: No findings (H-1 verified against the GucSource definitions).
- Testing: not re-run (no test change since round 3, which returned No findings).
- **Security N2 [Minor]** "as the service's role" did not say to log in to the service's database (`SET ROLE` applies no role settings); no direct catalog check.

## Tightening-only skip — Round 4
Findings applied directly (no Round 5 review):
- [N2] [Minor] alerts.md diagnosis must use a login to the service's database and list `pg_db_role_setting` directly — docs/operations/alerts.md `## rls.bypass_refused` — applied verbatim.
Justification: scoped within Round 3's fix range (the same paragraph), inline doc wording with no code or behaviour change, no security-boundary edit.
