# Code Review: verify-worker-readonly-role-rls-enforce

Date: 2026-11-15
Review round: 3

## Changes from Previous Round

Initial review. The Phase 2 self-check (three sub-agents) returned no findings but read only part of the diff, so round 1 was run as a first-pass review over the whole diff. Local LLM pre-screening and seeds were skipped: the diff is 106 files.

Findings are summarised from each expert's report; the Recurring Issue Check sections are kept as reported.

## Functionality Findings

- **F1 — Major.** `check-raw-sql-usage` is red at the reviewed commit: `scripts/checks/check-rls-grant-evidence.ts` reads its text baseline through a literal the gate does not scan, and the static-gates CI job runs that gate.
- **F2 — Major.** `docs/setup/aws/en.md` prescribes a bare `npx prisma migrate deploy` from a one-off task, which applies the flip with no preflight and no audit. The Vercel, GCP and Azure pages carry no note either.
- **F3 — Minor.** `clientMinMessagesViolations` passes when the audit's own connection (a setting on the migration role, or a startup option) masks a server-level `error`.
- **F4 — Minor.** `docs/security/tenant-boundary-matrix.md` says three login roles, has no verifier section, and states the old `system_settings` policy.
- **F5 — Minor.** The worker header names a compose service that does not exist.
- **F6 — Minor.** `README.md` and `docs/setup/docker/en.md` omit `ALTER ROLE … WITH LOGIN` for an existing compose cluster.
- **F7 — Minor.** The deviation log's F20 entry lists `log` as a level above `warning`.
- **F8 — Minor.** Two files of C12's member set are absent from the diff and unrecorded; `destructive-migration-baseline.txt` describes report mode in the present tense.
- **F9 — Minor.** The preflight treats a half-migrated new environment as production; the doc says a fresh environment needs no attestation.
- **F10 — Minor.** The connection limit of 10 assumes at most two verify tasks; `worker_desired_count` is unbounded.
- **F12 — [Adjacent] Minor.** No env-schema test for `AUDIT_CHAIN_VERIFY_DATABASE_URL`.

Answered without a finding: both orders of bootstrap and migration converge; the documented step 3 produces exactly the `rolcanlogin` pair (by reading and a local audit run, not on AWS); every worker statement stays inside the eleven columns; the stop rule did not fire. Thirteen of the 33 baseline grants were checked by hand against their call sites; the other twenty were not.

## Security Findings

- **S1 — Minor.** "No write of any kind" overstates the verifier role: through `PUBLIC` it keeps `TEMP` on the database, large objects and `NOTIFY`.
- **S2 — Minor.** Same as F3.
- **S3 — Minor.** Same as F2, plus a stale migrate command in `docs/operations/deployment.md`.
- **S4 — Minor.** Same as F4 (the role section).
- **S5 — Minor.** Report mode after an un-flip has no machine-readable signal, and `RLS_REPORT_MODE_ACK` never expires.

Answered without a finding: the role's live privileges are exactly the eleven column SELECTs, the two EXECUTEs, CONNECT, and what `PUBLIC` holds; no route returns the 42501 message or hint; every catch-and-continue around a database revocation logs at error level; the probe-role sweep cannot drop a foreign role; the deploy overrides and the preflight SQL admit no injection.

## Testing Findings

- **T1 — Major.** The verifier's INSERT denial cells assert only SQLSTATE 42501, which the RLS check also raises when INSERT is granted (executed).
- **T2 — Major.** The audit's mode check has no deny-side test through `main()`.
- **T3 — Minor.** D-5 says the account-token cell has no red proof; a mutated script copy turns it red (executed).
- **T4 — Minor.** The evidence recorder credits the probe role after a role switch on a probe connection, and takes the first `-c role=` where PostgreSQL takes the last.
- **T5 — Minor.** A test-local grant whose (purpose, tables) pair equals a production member's counts as that member's evidence; two pairs collide today.
- **T6 — Minor.** Two arms of the migrate-task wiring check are never made red; one cell is mislabelled; an `environment` entry is untested.
- **T7 — Minor.** The operator variable names and the flip migration name are literals in the deploy and wiring tests.
- **T8 — Minor.** The role-URL check does not compare `DATABASE_URL` itself when `APP_DATABASE_URL` is set.
- **T9 — Minor.** Two refusal cells assert nothing independent about the refused table.

Answered without a finding: the evidence step is reachable and not vacuous in CI (no sharding, no `if:`, a fresh file per job); the exact-privilege cell goes red on a twelfth column grant (executed); the five `todo` tests predate the branch.

## Adjacent Findings

- **S6 — [Adjacent] Minor (question), Security → Testing.** Does "with evidence" overcount grants whose reach happens inside a SECURITY DEFINER body that is RLS-exempt in CI?
- **F11 — [Adjacent] Minor (question), Functionality → Testing.** The baseline was produced by a local run; CI has not confirmed the same 33.

## Quality Warnings

None. Each finding names a file and gives evidence; T2 and T8 are marked by their author as read, not run.

## Recurring Issue Check

### Functionality expert

- R1: OK — the preflight, audit, bootstrap and password script reuse `pg` `Client`, `set_role_password`, `ROLES`, `loadDeniedPolicy`.
- R3: Finding F2, F4.
- R14: OK — the worker's statements fit the eleven columns; the manifest matches the live database for the role.
- R15: OK — the migration uses `current_database()`.
- R16: OK with a note — D-1 and D-4 environment differences are recorded; CI is the reference.
- R18: OK except the raw-SQL exemption (F1).
- R29: Finding F7; also F4's policy sentence.
- R32: OK — a boot cell with a declared ready signal exists (not executed by the reviewer).
- R33: OK — `ci-integration.yml` mirrors the role and password; no other workflow enumerates worker roles.
- R34: Applied to F4 and F5.
- R35: OK — a manual-test artifact exists.
- R36: OK — new allowlist entries carry reasons.
- R41: Finding F5.
- R42: OK — C10 and C2 member sets re-derived by grep; the one miss is F4.
- R44 / R50: Finding F1.
- R48: OK — the preflight and the audit decide different predicates.
- R49: OK.
- R52: OK — the audit's reach was extended and the manifest updated for all six roles.
- R55: F9.
- Not triggered: R2, R4–R13, R17, R19–R28, R30, R31, R37–R40, R43, R45–R47, R51, R53, R54, R56, R57.

### Security expert

- R3: checked — C10 sites enumerated by grep, all at error level; one doc miss (S4).
- R14: checked — exact on the live catalog; PUBLIC-inherited residue is S1.
- R15: pass.
- R16: pass — CI gives the role LOGIN; the superuser owner in CI is covered by the probe role and disclosed.
- R18: pass — env allowlist, denied-privileges, manifest and `AUDITED_ROLES` carry the role.
- R29: one inaccuracy (F20's "`error` and `log`"); the code is correct.
- R31: none performed by the review.
- R32: the boot cell exists; not executed.
- R33: pass.
- R35: present.
- R36: pass.
- R42: checked for the revocation-catch class and the migrate-path class (S3).
- R48: pass.
- R49: S1 and S3.
- R50: unit tests judged by exit code.
- R54: pre-existing design, unchanged.
- R55: checked — an empty `_prisma_migrations` meaning "fresh" has no realistic collision.
- RS4: pass. RS6: pass.
- Not triggered: R1, R2, R4–R13, R17, R19–R28, R30, R34, R37–R41, R43–R47, R51–R53, R56, R57, RS1, RS2, RS3, RS5.

### Testing expert

- R16: checked — no new assertion depends on the superuser's name; baseline parity with CI is unverified by execution.
- R21: checked — no probe role and no grant left after the reviewer's runs.
- R29: D-5's "no red proof" refuted by execution (T3); the 110 members and 33 baseline entries reproduce.
- R32: satisfied by the boot cell.
- R33: checked — the evidence step exists only in `ci-integration.yml`.
- R35: present.
- R42: `USER_OWNED_MODELS` is pinned to `STRANDED_COUNTERS`; the invalidation cell's ten tables are not derived from the grant (noted, not raised).
- R44 / R50: the evidence check fails on absent or empty input.
- RT1: the recorder's unit test uses a hand-copied statement; drift is caught by the CI evidence step.
- RT5: T2.
- RT6: four harness exports have no direct unit test; covered end to end by the CI evidence step.
- RT7: T1, T2, T3, T6.
- RT8: T1, T9.
- RT9: T7.
- RT10: T2 is allow-only.
- RT11: probe roles handled; case 19 has a trap restore.
- Not triggered: R1–R15, R17–R20, R22–R28, R30, R31, R34, R36–R41, R43, R45–R49, R51–R57, RT2, RT3, RT4.

## Environment Verification Report

- Verifier role privileges, policy shape, RLS arm order: `verified-local` (catalog queries on the worktree database).
- Integration suite enforcing, RDS-shaped cells, evidence record: `verified-local` (full suite, see Resolution Status).
- `rls-cross-tenant-verify.sql` Block 1 on an enforcing database: `verified-local` against the worktree database; the full smoke with its seed and negative cases runs in CI only (`blocked-deferred`: no host `psql`, plan C7; deviation D-4).
- ECS migrate command, `deploy.sh` forwarding, Terraform secret wiring, the acknowledgement alarm: `blocked-deferred` — no AWS call is made from this work (deviation D-8); covered by text-level wiring tests.
- Evidence baseline against CI: `blocked-deferred` until the first `ci-integration` run of this branch (F11).

## Resolution Status

### F1 Major — raw-SQL gate red
- Action: measured exemption `(scripts/checks/check-rls-grant-evidence.ts, "./rls-grant-evidence-baseline.txt", 1)` added; the gate and its self-test pass.
- Modified file: `scripts/checks/check-raw-sql-usage.mjs`

### F2 / S3 Major — launchers that skip the gate
- Action: the AWS page points to `deploy.sh` and gives the by-hand form as preflight, migrate, audit joined by `&&`; the Vercel, GCP and Azure pages and `deployment.md` say that a direct `prisma migrate deploy` flips the database with no attestation; the stale migrate command in `deployment.md` is corrected.
- Modified file: `docs/setup/aws/en.md`, `docs/setup/vercel/en.md`, `docs/setup/gcp/en.md`, `docs/setup/azure/en.md`, `docs/operations/deployment.md`

### F3 / S2 Minor — masked `client_min_messages`
- Action: the check reads the value only from a source every connection inherits; any other source fails as undecidable, whatever the value.
- Modified file: `scripts/audit-db-grants.mjs`, `scripts/__tests__/audit-db-grants-role-state.test.mjs`, `docs/operations/deployment.md`

### F4 / S4 Minor — boundary matrix
- Action: role count corrected, verifier section added, `system_settings` policy sentence updated.
- Modified file: `docs/security/tenant-boundary-matrix.md`

### F5 Minor — worker header
- Action: the claim of a compose service removed.
- Modified file: `scripts/audit-chain-verify-worker.ts`

### F6 Minor — LOGIN on an existing compose cluster
- Action: the `ALTER ROLE … WITH LOGIN` step added.
- Modified file: `README.md`, `README.ja.md`, `docs/setup/docker/en.md`

### F7 Minor — level order
- Action: the F20 entry rewritten.
- Modified file: `docs/archive/review/verify-worker-readonly-role-rls-enforce-deviation.md`

### F8 Minor — C12 members
- Action: the baseline comment reworded as history; `tenant-rls-purpose.ts` recorded as unchanged in the deviation log.
- Modified file: `scripts/checks/destructive-migration-baseline.txt`, the deviation log

### F9 Minor — half-migrated new environment
- Action: the refusal message and the doc say that such an environment needs the attestation.
- Modified file: `scripts/rls-enforce-preflight.mjs`, `docs/operations/deployment.md`

### F10 Minor — connection limit
- Action: the bound stated in the variable's description.
- Modified file: `infra/terraform/variables.tf`

### F12 Minor — rejected
- The field's valid, missing and invalid cases are covered where the worker validates it: `scripts/__tests__/audit-chain-verify-worker-env.test.mjs`.

### S1 Minor — "no write of any kind"
- Action: reworded to "no write to any application table or sequence" at every site; the `PUBLIC` residue (temporary tables, large objects, `NOTIFY`) added to the residual list. Revoking `TEMPORARY` from `PUBLIC` is not done here: it changes every role's manifest rows.
- Modified file: `scripts/env-descriptions.ts`, `.env.example`, `docs/operations/deployment.md`, `docs/security/security-review.md`, `scripts/audit-chain-verify-worker.ts`, `infra/terraform/ecs.tf`

### S5 Minor — acknowledged report mode is silent
- Action: an acknowledged audit also emits a JSON line (`_logType: "rls.report_mode_acknowledged"`); a metric filter on the app log group, where the migrate task logs, and an alarm count it on every such deploy. Wiring cells check the line against the filter pattern, the log group and the alarm's metric.
- Not done: an expiry on the acknowledgement. Between deploys, and on compose, an un-flip remains unreported; documented.
- Modified file: `scripts/audit-db-grants.mjs`, `infra/terraform/monitoring.tf`, `scripts/__tests__/audit-db-grants-role-state.test.mjs`, `docs/operations/alerts.md`, `docs/operations/deployment.md`

### T3 Minor — D-5
- Action: D-5 corrected with the reviewer's executed red proof.
- Modified file: the deviation log

### T1 Major — INSERT denial cells
- Action: the helper returns code and message; every INSERT, UPDATE and DELETE denial cell requires 42501 and `permission denied for (table|column)`. A statement that resolves is still a failure.
- Red proof (rolled-back transaction on the worktree database, grant given to the verifier): the INSERT fails with the row-level-security message, which the new pattern rejects; the `UPDATE … WHERE false` raises nothing.
- Modified file: `src/__tests__/db-integration/audit-chain-verify-worker-rls.integration.test.ts`

### T2 Major — mode check through `main()`
- Action: five cells run the real audit process against an empty database the test creates and drops, in which only `rls_bypass_enforced()` exists: report mode without an acknowledgement, with one, with a whitespace one, the function absent, and the function true as the allow control.
- Found while writing them: the audit printed its findings and then called `process.exit(1)`, which on a pipe cut the report short in about one run in three, losing the last finding. The findings branch now sets `process.exitCode` and returns. The migrate task's log driver is a pipe too.
- A `FUNCTION_RULE_ALLOWLIST` entry covers the function the test creates.
- Modified file: `src/__tests__/db-integration/audit-db-grants.integration.test.ts`, `scripts/audit-db-grants.mjs`, `scripts/checks/check-bypass-rls.mjs`

### T4 Minor — role switch on a recorded connection
- Action: the recorder marks a connection once it sees a role or session-authorization switch and records its later grants under a name no role has, so they count as no evidence; the last `-c role=` wins.
- Modified file: `src/__tests__/db-integration/rls-grant-evidence-recorder.ts`, its test, `setup.ts`

### T5 Minor — test grants colliding with members (also answers S6 in part)
- Action: the four colliding test grants now either use the member by name or a pair no member has. A new guard reads every `defineGrant` call under `src/__tests__/db-integration` and fails on a pair equal to a member's, and on a call it cannot read unless listed with a reason.
- Red proof: run on the tree before the fixes, the guard reported exactly the four collisions.
- The baseline did not move: 77 with evidence, 33 without.
- Modified file: `scripts/__tests__/integration-test-grants-no-collision.test.mjs` (new), four integration test files

### T6 / T7 Minor — wiring and deploy tests
- Action: fixtures for the two arms that were never red, a migrate-container twin for secrets and one for `environment`, the mislabelled cell retitled; the variable names and the migration name are imported from the scripts that define them, and a cell checks `deploy.sh` names exactly those.
- Modified file: `src/__tests__/infra/migrate-task-wiring.test.ts`, `scripts/__tests__/deploy-rollback.test.mjs`, `scripts/audit-db-grants.mjs` (export)

### T8 Minor — `DATABASE_URL` in the role-URL check
- Action: `DATABASE_URL` is compared as well.
- Modified file: `src/__tests__/db-integration/setup.ts`, `role-url-consistency.test.ts`

### T9 Minor — refusal cells
- Action: the expected table is a literal in the first; the second asserts the notice's table and purpose.
- Modified file: `team-member-key-prune.integration.test.ts`, `share-departure.integration.test.ts`

### S6 Adjacent — evidence inside definer bodies
- Not changed. The owner-swap cells for the definer routines run on a superuser login and so record no evidence; a grant counted as evidenced was set by a restricted role on some path, which says the grant was set, not that every statement under it could have been refused. The checker's header states this limit.
- Anti-Deferral: worst case — a definer-consumed grant omits a table and production refuses it. Likelihood — low: the three definer routines each have an owner-swapped allow cell (C8). Cost to fix — per-statement attribution in the recorder.

### F11 Adjacent — baseline against CI
- Open until the first `ci-integration` run of this branch. A divergence in either direction fails the step.

### Verification after the fixes
- Full integration suite with a fresh evidence file: 154 files, 1658 passed, 5 todo, exit 0; evidence check exit 0.

## Round 2

Incremental review of the round-1 fixes by the same three experts. No Critical or Major finding. The testing expert red-proved, on scratch copies, the cells the fixing pass had left unproven: the verifier denial cells under a granted state (all nine write cells red), every arm of the migrate-task wiring check, twelve mutations of the recorder, six mutations of the audit's mode check, and the role-URL check; the mode cells ran five times without a failure, and three of six runs failed with `process.exit(1)` restored.

### Findings

- **F13 — Minor.** `deployment.md` listed `npm run db:migrate` as a `prisma migrate deploy` launcher; it runs `prisma migrate dev`.
- **F14 / N7 — Minor.** The `--write` refusals still printed a multi-line report and then called `process.exit(1)`.
- **S7 — Minor.** The recorder's role-switch match missed a switch after a comment, inside a DO body, through `set_config` with a non-literal name, and an upper-case `-c ROLE=`; each credits the startup role.
- **S8 — Minor.** An acknowledgement left set while the database is enforcing emitted nothing, so "the alarm fires on every deploy that carries it" held only in report mode, and the leftover variable would pre-authorise a later un-flip.
- **S9 — Minor.** The boundary matrix said the verifier holds EXECUTE on two functions "only"; four invoker functions are executable through `PUBLIC`.
- **N1 — Minor.** A listed undecidable `defineGrant` call is excused by its text, and the cell that claimed to check its rows used hand-copied values: a colliding row added to the `it.each` table stayed green (executed).
- **N2 — Minor.** The collision guard does not follow a local alias, a re-export, `.call`, a spread or object-literal grant, the raw statement, or integration tests outside `db-integration`. Nothing in the tree uses these forms.
- **N3 — Minor.** The `--write` refusal in report mode had no test; removing it left the file green (executed).
- **N4 — Minor.** A non-zero status did not show that the run reached the mode check.
- **N5 — Minor.** The `--role=` and `-crole=` arms of the option pattern had no test.
- **N6 — Minor.** The `process.exitCode` fix was pinned only by a flake, with a misleading failure message.

### Resolution Status

#### F13
- Action: sentence corrected.
- Modified file: `docs/operations/deployment.md`

#### F14 / N7
- Action: both `--write` refusals set `process.exitCode` and return before the manifest is written. The remaining early exits print one short message.
- Modified file: `scripts/audit-db-grants.mjs`

#### S7 / N5
- Action: the switch pattern matches anywhere in the statement, with and without block comments, and treats a `set_config` as a switch when its setting name is `role` or `session_authorization`, or is not a plain quoted literal; a statement whose text cannot be read marks the connection; the option pattern ignores case; a `session_authorization` startup option makes the startup role untrusted. Cells for each spelling, for the two untested option forms, and for the allow side (a Prisma update of a quoted `role` column, a tenant `set_config`, the bypass statement itself).
- Not covered, stated in the code: a switch made inside a function the statement calls.
- The first version treated every `set_config` outside `app.` as a switch. The row-lock helpers send `set_config('lock_timeout', …)`, so the full run's evidence check failed with five members losing their evidence (123 unattributed grant lines instead of 7); the rule was narrowed and an allow cell for the timeout statement added.
- Modified file: `src/__tests__/db-integration/rls-grant-evidence-recorder.ts`, its test

#### S8
- Action: an enforcing audit with a non-empty acknowledgement warns to remove it and emits the same `_logType` line, so the alarm fires; a whitespace-only value stays silent. The alarm's comment and description and `alerts.md` say what triggers the line. A cell runs it through the real process.
- Modified file: `scripts/audit-db-grants.mjs`, `scripts/__tests__/audit-db-grants-role-state.test.mjs`, `src/__tests__/db-integration/audit-db-grants.integration.test.ts`, `infra/terraform/monitoring.tf`, `docs/operations/alerts.md`

#### S9
- Action: the section separates what is granted by name from what `PUBLIC` gives, names the invoker functions and points to the manifest as the complete list.
- Modified file: `docs/security/tenant-boundary-matrix.md`

#### N3 / N4 / N6
- Action: two cells run `--write` against a database in report mode (with an acknowledgement) and with the function absent, and require the refusal text, a non-zero status and no file. Every verify cell that depends on the report first requires the findings header, a finding of the empty database and the last line of the help text, so a run that died early or was cut fails by name.
- The two `--write` cells were not red-proved separately; the reviewer's mutation (refusal removed) writes the file, which the cells' file-absence assertion reads.
- Modified file: `src/__tests__/db-integration/audit-db-grants.integration.test.ts`

#### N1 / N2 — Accepted, with the guard's reach stated
- Action: the hand-copied cell is removed, because it claimed a check it did not make. The guard's header now says what it is: a catch for a literal `defineGrant` in a test under `src/__tests__/db-integration` that repeats a member's pair. It lists what it does not follow, and names review of the test change as the control for those.
- Why not extended: each form the guard would have to follow is another spelling to chase (this round and the last both added spellings to the recorder and the guard). Closing the class needs a different mechanism — crediting evidence by the identity of the `BYPASS_GRANT` object that `setBypassGucs` receives, joined to the connection — not more cases.
- Anti-Deferral: worst case — a test credits a member with evidence it did not earn, the member leaves the baseline, and a grant that omits a table is refused in production; recovery is the un-flip. Likelihood — low: it needs a test author to build a grant in one of the unusual forms and to repeat a member's pair; none does today. Cost to fix — the identity-based recorder (a wrapper around `setBypassGucs` in the harness and an async context reaching the pg client).
- Modified file: `scripts/__tests__/integration-test-grants-no-collision.test.mjs`

### Verification after the round-2 fixes
- Full integration suite with a fresh evidence file: 154 files, 1661 passed, 5 todo, exit 0. Evidence check exit 0: 77 with evidence, 33 without, baseline unchanged.
- Full unit suite: 1170 of 1171 files pass; the failure is the worktree-only `backup-db` case (one test, the script's own compose call). Production build, typecheck and lint pass.
- Static gates: all pass except `rls-cross-tenant SQL parse`, which reads the shared development database `passwd_sso`; that database has not had the flip migration applied, so the new `[E-RLS-ENFORCED]` check refuses it. The same SQL passes Block 1 against this worktree's database.

## Round 3

Incremental review of the round-2 commit by the same three experts. No Critical or Major finding. The testing expert red-proved the `--write` refusal cells (refusal removed, `return` removed, exit code removed: each reddens its own assertion), the leftover-acknowledgement cells, and seventeen mutations of the recorder; the mode block ran five times without a failure.

### Findings

- **F15 — Minor.** The restore step did not tell the operator to stop exporting `RLS_REPORT_MODE_ACK`, which now raises the alarm while enforcing.
- **S10 / T4 — Minor.** The recorder's role-switch match still missed spellings that change `current_user` (a quoted setting name, a line comment between the keywords, a composed `set_config` name, a quoted `set_config`, dynamic SQL), each confirmed on the database; its comment named only one blind spot.
- **S11 — Minor.** The collision guard's header omitted `.call`/`.apply`/`.bind` and computed access from what it does not follow.
- **T1 — Minor.** `expectWholeReport` was called in three of the six verify cells, not in all as the round-2 entry said.
- **T2 / T3 — Minor.** Two recorder arms had no cell (the unstripped reading; two forms of the `session_authorization` option).

### Resolution Status

#### F15
- Action: the restore step says to stop exporting the variable and why; the `deploy.sh` and audit header comments say the same.
- Modified file: `docs/operations/deployment.md`, `scripts/deploy.sh`, `scripts/audit-db-grants.mjs`

#### S10 / T2 / T4 — the mechanism is replaced, not extended
- Three rounds found spellings the statement match missed, and dynamic SQL cannot be matched at all. The match is deleted.
- Action: the probe role logs in as itself and holds the owner's privileges through a membership `WITH INHERIT TRUE, SET FALSE`, so PostgreSQL refuses any switch; a cell checks `SET ROLE`, `SET SESSION AUTHORIZATION` and `set_config('role', …)` are refused. The recorder credits the login user of a connection whose startup options set neither `role` nor `session_authorization`. Attribute lines record whether a role holds a SET-able membership, from one shared query; the consumer requires none, and treats a line without the field as not restricted.
- Red proof (scratch copies): with the consumer's membership condition removed, its new cell fails; with the recorder's option rule removed, thirteen cells fail.
- Remaining limit, stated in the consumer's header: statements inside a SECURITY DEFINER routine (S6).
- The full suite's evidence is unchanged: 77 with evidence, 33 without.
- Modified file: `src/__tests__/db-integration/rds-probe-role.ts`, `rds-probe-role.integration.test.ts`, `rls-grant-evidence-recorder.ts`, its test, `setup.ts`, `scripts/checks/check-rls-grant-evidence.ts`, its test, `scripts/checks/check-bypass-rls.mjs` (one allowlist reason)

#### T3
- Action: the option cells are a table over both settings, the three forms and both letter cases.
- Modified file: `src/__tests__/db-integration/rls-grant-evidence-recorder.test.ts`

#### S11
- Action: added to the header's list.
- Modified file: `scripts/__tests__/integration-test-grants-no-collision.test.mjs`

#### T1
- Action: all six verify cells call `expectWholeReport` first.
- Modified file: `src/__tests__/db-integration/audit-db-grants.integration.test.ts`

#### Correction to the round-2 N1 / N2 entry
- The identity-based recorder named there would close the collision class only. The role question it was also said to answer is closed by the change above.
