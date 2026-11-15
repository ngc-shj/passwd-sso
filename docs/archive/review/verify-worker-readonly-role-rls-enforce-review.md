# Plan Review: verify-worker-readonly-role-rls-enforce

Date: 2026-11-14
Review round: 1

## Changes from Previous Round

Initial review. Local LLM pre-screening and merge were unavailable (Ollama down); findings were merged by hand. Each expert's full output, including its Recurring Issue Check, is kept verbatim at the end.

## Convergence

- S2, F2 and F1 (security and functionality) meet on one root cause: the plan gated the flip at the merge, in prose. Severity floor Major; resolved by D1 (gate at the deploy) and C9 (attestation preflight).
- T5, F5 and F11 meet on C11's missing mechanism; T6 on its over-claim.
- T4, F10 and S8 meet on the on-connect read; resolved by removing it (D6).
- S7 and T14 meet on the OR-arm order.

## Dispositions

| ID | Sev | Label | Disposition |
|---|---|---|---|
| F1 | Major | design | Fixed: C9 existing-RDS order; `rolcanlogin` row in C1 acceptance and the mutation table. |
| F2 | Major | design | Fixed: D1 gate moved to the deploy; C9 preflight with a declared control class; D1 stop rule for grant fixes. |
| F3 | Major | design | Fixed: C2 member set extended (baselines, restore runbook, docker setup doc, count prose). |
| F4 | Major | design | Fixed: C2 names the entries worker roles carry. |
| F5 | Major | design | Fixed: C11 producer, store, consumer and filtered-run behaviour. |
| F6 | Minor | design | Fixed: C12 closes the publisher item; C6 compares each role URL's database. |
| F7 | Minor | design | Fixed: C3 names `main()` and the split tests; the URL stays in `envObject` because #947 asks for it. |
| F8 | Minor | design | Fixed: C5 carries `PARALLEL SAFE`; C7 pins it; migration order stated. |
| F9 | Minor | design | Answered in C8: trigger bodies are adjudicated by the database when a test fires them. |
| F10 | Minor | design | Moot: the on-connect read is removed (D6); the cross-session note is in D4. |
| F11 | Minor | design | Fixed with T6: C11 states what evidence means. |
| F12 | Minor | prose | Fixed: "statements"; C6 cites test names. |
| S1 | Major | design | Fixed: C1 converges an existing role and asserts its attributes. |
| S2 | Major | design | Fixed with F2. The separate-release alternative is recorded in D1 with what it satisfies; the stop rule adopts it if a grant must change. Self-hosted flip stated; release marked breaking. |
| S3 | Major | design | Fixed: `audit-db-grants` fails on report mode without an explicit flag (C5). A committed un-flip migration and a heartbeat line were not taken: the audit runs on every deploy and is the detection. |
| S4 | Major | design | Partly fixed: C10 member set re-derived by class, error-level logging at each. Failing the rotate-key request and retrying SCIM/team removal: Accepted, see the plan's Carried-Forward Plan Findings and SC6. |
| S5 | Major | design | Partly fixed: `CONNECTION LIMIT` in C1. Role-level timeouts rejected: they are session defaults the credential holder can override, so they bound nothing. Advisory-lock starvation recorded as a residual shared by every role. |
| S6 | Minor | prose | Fixed: C1's control class states the tenant-scope limit; C5 lists what the flip does not cover. |
| S7 | Minor | design | Fixed: D5 reworded; sentinel case in C7. |
| S8 | Minor | design | Moot for the self-clearing signal (the read is removed). The WARNING-independent metric is SC7. |
| T1 | Major | design | Fixed: `expectBypassRefusal` in C6. |
| T2 | Major | design | Fixed: C6 rules for a refusal cell; the `enforced: false` post-state is in the member set. |
| T3 | Major | design | Fixed: exact-privilege cell is C1's acceptance. |
| T4 | Major | design | Moot: the on-connect read is removed (D6). |
| T5 | Major | design | Fixed: C11. |
| T6 | Major | design | Fixed: C11 and E1 narrowed. |
| T7 | Major | design | Fixed: C7 sub-block shape, negative cases, scoped allowlist entry. |
| T8 | Major | design | Fixed: C8 reworded per routine. |
| T9 | Major | design | Fixed: C8 probe role through the connection `options`; non-vacuity stated; mutation rows added. A mocked grants module was not taken. |
| T10 | Major | design | Fixed: C4 boot cell with a ready signal; C12 manual-test steps. |
| T11 | Minor | design | Fixed: E5 preflight message, fallback password, `infra/postgres/**` filter. |
| T12 | Minor | design | Fixed: one forbidden pattern, owned by the function rule. |
| T13 | Minor | design | Fixed: prune cells seed their rows; verification commands listed. |
| T14 | Minor | design | Adjacent, routed to security: covered by S7 and S6. |

## Anti-Deferral entries

### S4 (part) Major — Accepted
- Anti-Deferral check: worst case — sessions and tokens survive a key rotation or deprovision when revocation throws. Likelihood — unchanged by the flip once C8's cell shows the grant complete; any database error has this effect today. Cost to fix — a client-visible contract change on a post-commit path, across web, CLI and extension.
- Tracked: SC6, follow-up issue filed with the PR.

### S5 (timeouts) Major — Skipped
- Anti-Deferral check: worst case — a holder of the verifier credential holds connections or locks. Likelihood — requires the credential. Cost to fix — none available at the role level: `ALTER ROLE … SET` values are defaults a session may change.
- The enforced part (`CONNECTION LIMIT`) is taken.

### S8 (second metric) Minor — Out of scope
- Anti-Deferral check: worst case — a swallowed refusal with the WARNING channel closed leaves no metric. Likelihood — needs a role or database setting the deploy-time audit refuses. Cost to fix — a new filter per log group and its tests.
- Tracked: SC7.

---

## Round 2 (2026-11-14)

### Changes from Previous Round

The plan was rewritten for round 1's 34 findings. Round 2 found no Critical. It found 11 Major, 9 of them against mechanisms round 1 added (the deploy preflight, the mode audit, the probe role, the evidence record), and 2 continuing. The revision answers them by narrowing those mechanisms rather than adding to them.

### Dispositions

| ID | Sev | Label | Disposition |
|---|---|---|---|
| F13 | Major | design | Fixed: only an absent or empty migration table passes without the attestation (C9). |
| F14 | Major | design | Fixed: the mode audit passes in report mode with a forwarded acknowledgement carrying a reason (C5). |
| F15 | Minor | design | Fixed: C9 surfaces list. |
| F16 | Minor | design | Fixed: `ALTER` in the convergence block, `rolconnlimit` audited, pool cap 2 with the arithmetic (C1, C3). |
| F17 | Minor | design | Fixed: measure, moment and fallback in D1. |
| F18 | Minor | design | Fixed: normalised table order, shared evidence stated, `SET LOCAL ROLE` under-count stated (C11). |
| F19 | Minor | prose | Fixed with S12: the audit reads the effective value. |
| S4 | Minor | prose | Fixed: reason corrected; rotate-key needs no further change; SC6 narrowed to SCIM and team removal, filed before the PR. |
| S9 | Minor | design | Partly fixed: `ALTER … CONNECTION LIMIT`, the wedge stated. The in-migration ACL loop was not taken: `audit-db-grants` runs in the same migrate task before any service update and compares effective privileges, which covers other grantors, ownership, settings and other schemas. |
| S10 | Minor | design | Reconciled with F14: the acknowledgement is forwarded explicitly, carries a reason, is printed, is never defaulted (wiring test), and `--write` refuses in report mode. An argv-only flag would leave the fix release undeployable. |
| S11 | Minor | design | Fixed: value bound to the migration name; applied defined (C9). |
| S12 | Minor | design | Fixed: effective `client_min_messages` check in the audit (D6). |
| S13 | Minor | design | Fixed: the probe is a member of the owner role, holds no ACLs, random name, sweep, no members; the recorder never logs the URL (C8, C11). |
| S14 | Minor | design | Fixed with F16. |
| T2 | Minor | design | Fixed: the write-absent rule distinguishes harness-rolled-back cells (C6). |
| T5 | Major | design | Fixed: attribute lines in the evidence file; append-only; the consumer reads only the file and fails on an unknown role (C11). |
| T7 | Major | design | Fixed: D5 pins moved to integration cells and declared observation pins; the sentinel case runs on `tenants`; the mutation row is dropped (C7). |
| T9 | Major | design | Fixed: a new file with one cell per `TENANT_*` grant; the existing suites are not re-run (C8). |
| T10 | Major | design | Fixed: ready signal restricted to the cell's tenant, timeout, child cleanup, `application_name` (C4). |
| T15 | Major | design | Fixed: rows re-pointed, missing rows added, manifest rows pinned in the role-state test. |
| T16 | Major | design | Fixed: mode decision is a pure function with a unit test (C5). |
| T17 | Major | design | Fixed with S13. |
| T18 | Major | design | Fixed: pure decision function, name-existence test, wiring tests (C9). |
| T19 | Minor | design | Fixed: marked convergence block and a replay cell (C1). |
| T20 | Major | design | Fixed: privileges by inheritance from the owner role; probed (C8). |
| T21 | Minor | design, needs-execution | Carried to Phase 2: the check's shape is fixed against the real catalog (C7). |

### Anti-Deferral entries

### S9 (ACL loop) Minor — Skipped
- Anti-Deferral check: worst case — a role of this name that already holds a grant the block cannot revoke keeps it until the audit runs. Likelihood — the name is new; the audit runs in the same task, before any service connects as the role. Cost to fix — a catalog walk duplicating the audit inside a migration.

---

## Rounds 3 and 4 (2026-11-14)

### Changes from Previous Round

Round 3: security returned no findings; functionality returned one Minor (F20); testing returned two Major (T22, T23) and one Minor (T24), all against the evidence consumer, the probe sweep and the boot cell's wording. Round 4 re-ran testing on those three fixes: resolved, one Minor (T25).

| ID | Sev | Label (as filed) | Disposition |
|---|---|---|---|
| F20 | Minor | design, needs-execution | Plan names `pg_settings` with its source; which sources count is carried to Phase 2. |
| T22 | Major | design, needs-execution | Fixed: an unknown role's line is no evidence and is tallied; it does not fail the step (C11). |
| T23 | Major | design | Fixed: creation time in the name; only roles older than an hour are swept; selector unit test (C8). |
| T24 | Minor | prose, needs-execution | Fixed: ready signal reworded (C4). |
| T25 | Minor | design | Fixed: the consumer fails when a role `setup.ts` describes has no attribute line, or no line resolves to an RLS-subject role (C11). |

### Saturation call (after round 4)

1. Four rounds completed.
2. No Critical or Major finding is open: every one is resolved in the plan file. S4's remaining part was re-filed by the security expert as Minor, prose, in round 2 and closed in round 3.
3. No open finding is against the design: rounds 3 and 4 raised none against a contract, a control class or an invariant that is not already fixed.
4. Remaining Minor findings, as their experts labelled them: F20 (design, needs-execution) and T21 (design, needs-execution). Both are reachable only by building and running the implementation. They are in the plan's Carried-Forward Plan Findings with Anti-Deferral entries.

All twelve contracts are locked. Phase 1 exits on saturation.

---

# Expert outputs (verbatim), round 1

## Functionality expert

## Functionality review, Round 1 (full): verify-worker-readonly-role-rls-enforce-plan.md

Method: I read the plan and both issues, then checked every contract against the worktree code. I recomputed the member sets with my own greps. I did not re-run your probes. The statements the verify worker issues are covered by D2: `tx.tenant.findMany({select:{id:true}})`, `set_config`, `current_setting`, and the four reads in `readChain`. `withTenantRls`, `withBypassRls` and `setBypassGucs` need no table privilege. Two things hold up:
- The migration-lint gate does force later migrations to name tables. `check-migration-rls-dml.mjs` refuses a top-level reference to a FORCE table, and requires a lexically visible `app.bypass_tables` list inside a `DO` body. It is blind to function and trigger bodies.
- The C6 cell list matches the code. The grep finds exactly the nine files the plan names, and the plan's line numbers are the `it(` lines.

### Requirements coverage (#921 and #947 bullets)
- Covered by E1/C-contracts: zero window plus alarm armed (E1), canaries (E1), `client_min_messages` detection (C10), per-grant evidence (C11), fixture and per-table refusal (C7), tenant-domain/migrate-script cells (C8), definer cell (C8), `invalidateUserSessions` cell and error logging (C8/C9), prod and rollback at report-mode release (E1), OR-arm order (D5), D6 (D6).
- No explicit home:
  - Publisher log group, metric filter and canary. This is already satisfied: `infra/terraform/monitoring.tf:68-77` has five groups, including `audit_anchor_publisher`. The plan should say so (F6).
  - Scratch-DB purposes (F6).
- #947: role, initdb/bootstrap/audit, ECS wiring and env schema are all present. The deploy order is wrong (F1).
- The "writes to audit tables" phrasing is not what the denied-privileges file holds (F4).

### Findings

**F1 — Major — design — The C3/C12 deploy order for an existing RDS cannot be executed, and it ignores that the flip rides the first deploy**
- Problem: The plan says "role converged by bootstrap with the new password, then secret key, then release". The new bootstrap script and its new `ROLES` entry exist only in the new image's migrate task definition. That task definition is registered by `deploy.sh`'s `terraform apply`. `deploy.sh` is migration-first. The manifest expects a LOGIN role, so the first `deploy.sh` stops at the grant audit after the migrations have already committed. The flip is one of those migrations. The old services keep serving against an already-enforcing database until the operator runs the bootstrap and re-runs `deploy.sh`.
- Evidence:
  - `docs/operations/deployment.md:149-181`, "One-time upgrade: anchor publisher converged", is the precedent: "the first deploy.sh ... stops at the audit by design".
  - `scripts/checks/db-grants-manifest.json:81` has `ROLEATTR:passwd_anchor_publisher rolcanlogin true`. A migration-created role is NOLOGIN.
  - `docs/operations/deployment.md:704-712` says the migrate task command is `prisma migrate deploy && node scripts/audit-db-grants.mjs`.
- Impact: The plan's "Operator, existing RDS" scenario and the C3 deploy-order bullet are wrong. The E1 sign-off must happen before the first `deploy.sh`, not before the second. The C1 acceptance ("manifest lists exactly those rows") is also incomplete: the manifest must carry `ROLEATTR ... rolcanlogin true` for the verifier. That only comes out if the role is LOGIN in the database used for `--write` (E5).
- Fix:
  - Add a "One-time upgrade" subsection to `deployment.md` that follows the publisher precedent: add the secret key by the documented read-merge-write; run `deploy.sh` and expect the audit stop; run the bootstrap with five passwords; re-run `deploy.sh`.
  - State that the flip is already applied after step 1.
  - Rewrite the operator scenario.
  - Keep the allow case: the second `deploy.sh` must pass the audit, and the verify worker must start as the new role.
  - Put a mutation on the manifest `rolcanlogin` row (it must go red when the row is removed).

**F2 — Major — design (R49) — E1 is a "merge gate", but merging does not deploy; the real gate is the first `deploy.sh`**
- Problem: D1 says "the merge is the flip, so the PR must not merge until E1's gates are signed off". Merging to main does not touch production. `release.yml` only runs release-please and publishes the CLI. Deploys are operator-run `deploy.sh`.
- Impact:
  - Any later deploy from main, such as a hotfix, applies the flip. Nothing mechanical checks the E1 sign-off.
  - Holding the merge for the whole zero window blocks main for no production benefit.
  - C12 declares no control class for this human gate.
- Related: any grant fix made under C6 is not on the old tasks. They keep serving while the migrate task flips the database, before `update-service`. E1 gate 3 ("at or above the report-mode release") does not cover grant fixes made in this release.
- Fix: Relocate the gate to the deploy and declare it advisory or enforced. Options:
  - Put the flip migration in its own release.
  - Add a `deploy.sh` preflight that refuses a pending flip migration without an explicit acknowledgement.
  - Keep the human gate but state that, and add a mutation or allow case for any mechanical part.
  - Name what the rejected "separate flip" alternative satisfied: a hotfix deploy that does not flip.
  - State in the PR body and `deployment.md` whether C6 grant fixes are expected. If they are, the report-clean window does not evidence them.

**F3 — Major — design (R42/R18/R14) — The C2 "footprint" member set omits surfaces that the code requires**
- Evidence: I re-ran `grep -rIl passwd_anchor_publisher` with the plan's exclusions, and also compared the footprint of the other worker roles. These are in the code and not in the plan:
  - `scripts/checks/migration-rls-dml-baseline.txt`. Every role-creating migration has a `DYNAMIC` entry for `EXECUTE format('GRANT CONNECT ON DATABASE %I ...', current_database())`: lines 21 and 35-40 (outbox worker, dcr cleanup, retention-gc, publisher). C1's own "CONNECT on `current_database()`" implies the same entry, or CI goes red.
  - The new migrations need `BEGIN/COMMIT` and a check against `migration-transaction-baseline.txt`; the older role migrations are baselined there. Not mentioned.
  - `docs/operations/dev-host-migration.md:265-267`, the restore runbook's per-role `GRANT CONNECT` list.
  - `docs/setup/docker/en.md:133`, the table row for `PASSWD_ANCHOR_PUBLISHER_PASSWORD`.
  - Count prose: `deployment.md:187` ("all four passwords"), `deployment.md:712` ("converges the four login roles"), `infra/terraform/README.md:214` ("four role passwords") and its `.ja` twin. C12's grep pattern cannot find these.
  - `deployment.md:841-886` and `docs/setup/aws/en.md:81` say the publisher password is taken from the URL userinfo. The verifier needs the equivalent sentence.
- Fix: Add them to C2/C12. Add a gate-name column for each new-migration gate it must satisfy: dml-baseline, transaction-baseline, destructive-baseline (not triggered, since `CREATE OR REPLACE FUNCTION` and `REVOKE` are not matchers) and function-rule (migrations are exempt). Pin the new migration timestamps after `20261110000000_rls_backfill_rerun`, role migration before the flip.

**F4 — Major — design (R29) — C2 misdescribes `app-role-denied-privileges.json`**
- Evidence:
  - The plan says: "the audit tables' write privileges, as for the publisher".
  - The publisher's entries in the file are `tenant_claim_events` (all privileges), `tenant_claim_events_seq_seq` (USAGE, SELECT, UPDATE) and `tenant_claims` (all). Only `passwd_app` has the `audit_logs` and `audit_chain_anchors` UPDATE/DELETE entries.
- Impact: An implementer following the plan writes the wrong entries and leaves the denied policy incomplete for the new role.
- Fix: State the three entries each other worker role carries. If audit-table denials are wanted for the verifier, name them separately; the "no write privilege" invariant is already schema-enforced by omission.

**F5 — Major — design — C11 has no cross-process evidence mechanism and no producer-to-consumer walkthrough**
- Evidence:
  - `vitest.integration.config.ts` uses `pool: "forks"`, `maxWorkers: 1`, `isolate: true`. `setup.ts` is a `setupFile`, so it runs once per test file.
  - The harness would therefore hold evidence in memory per file.
- Gaps in the plan:
  - How per-file evidence is aggregated for the end-of-run comparison (a globalSetup/teardown or an append-only file).
  - What the committed-list file looks like.
  - Who regenerates it when a grant is added (110 `BYPASS_GRANT` entries today).
  - What a single-file run does.
  - What the environment flag is and where it is set (`ci-integration.yml`).
- Impact: As written, the comparison either cannot be implemented or silently compares one file.
- Fix: Add a walkthrough: producer (harness record), store, consumer (the comparison), regenerator command, subset-run behaviour (comparison skipped loudly, not green), and a refusal when no records exist.

**F6 — Minor — design — Two #921 bullets lack a stated home**
- (a) The publisher log group, metric filter and canary are already done (`monitoring.tf:68-77` has five groups, and the C10 test covers "the five groups"). Say so, so the checklist item closes.
- (b) The D1 "moot" sentence says the three items' purposes are carried by C6. The scratch-DB item's purposes include "refuse to start when `.env.local` overrides" a `*_DATABASE_URL`. C6 does not carry that.
  - Evidence: `setup.ts:8-9` loads `.env.local` with `override: true`.
  - Evidence: `helpers.ts:30-75` takes the role connection strings from per-role env vars.
  - A superuser-connection probe saying "enforcing" does not prove each role connection hits the same database.
  - The C4/C6 refusal cells would still go red against a report database, so the exposure is bounded. The allow cells and the C11 evidence could still run against the wrong database.
- Fix: Run the `rls_bypass_enforced()` check through each role's connection, or assert the same `current_database()` and port across probes.

**F7 — Minor — design — C3 is under-specified against the actual worker env code**
- Evidence: `scripts/audit-chain-verify-worker.ts:535` picks the URL name, and `:588` still does `?? process.env.DATABASE_URL` in `main()`. Existing tests include "passes with the DATABASE_URL fallback" and "names DATABASE_URL when the fallback is the unparseable one" (`audit-chain-verify-worker-env.test.mjs`). The runner stage sets `NODE_ENV=production` (`Dockerfile:166`), so the smoke check and the ECS task would both be in production mode; the test harness uses `env -i`, so it sets `NODE_ENV` explicitly.
- Problems: The plan's mutation row ("production fallback restored") is fine, but:
  - It does not say `main()` is changed, nor how the fallback tests are rewritten around `NODE_ENV`.
  - `envObject` is consumed by the app and by the publisher's `.pick()`. The verify worker's own settings (`AUDIT_CHAIN_VERIFY_TICK_INTERVAL_MS` and the rest) are not declared in `envObject`, `env-descriptions.ts` or `env-allowlist.ts`.
  - Adding only the URL there pulls in `.env.example`, `env-descriptions.ts`, `generate:env-example` and `check:env-docs`, with no consumer.
- Fix: State why the URL goes into `envObject`, or leave it where its siblings are. Name the `main()` change and the rewritten tests.

**F8 — Minor — design — The flip migration's attribute list omits PARALLEL SAFE**
- Evidence: The report-mode definition is `LANGUAGE sql IMMUTABLE PARALLEL SAFE` (`20261019000000.../migration.sql:12`). The plan says "same signature, language and volatility".
- Impact: `CREATE OR REPLACE` keeps owner and ACL but takes every other attribute from the new statement, so an omitted `PARALLEL SAFE` reverts to UNSAFE. This should have no runtime effect (`rls_bypass_admits` is labelled safe and PostgreSQL does not check its callees), but it is silent attribute drift on a security function.
- Fix: Add `PARALLEL SAFE` to the contract. Optionally pin `proparallel` and `provolatile` in the C7 catalog check.

**F9 — Minor (question) — design — Trigger and invoker-function bodies are not in any member set**
- Evidence: C8 enumerates `SECURITY DEFINER` routines only. Table scans also happen in SECURITY INVOKER trigger functions:
  - `trg_after_insert_users_tenant_owner_membership` inserts into `tenant_members` (`20260227050000.../migration.sql:196-229`).
  - The `tenant_claims` deregister trigger writes `tenant_claim_events`.
  - `share_creator_admitted` sets its own grant for three tables.
- Mitigations: `AUTH_CREATE_USER` and the `TENANT_CLAIM_*` grants already name those tables. Foreign-key actions and RI checks bypass RLS (PostgreSQL docs), so they are not a concern.
- Question: Is enforcement evidence meant to cover tables scanned by trigger bodies? If yes, name them in C8/C11 or state that C11 evidences only the grant writer.

**F10 — Minor — design — C10 edge cases**
- The plan does not say what happens when the on-connect `SHOW` itself fails (Remedy Floor clause 3: "examined nothing" must not read as "found nothing").
- "Once per process per role" needs `current_user` in the same statement, or a second query.
- `createClient()` (`pool-factory.ts:183`) has no callers outside tests, so it is out of scope. Say so.
- `audit-db-grants` already flags a role-level `ALTER ROLE SET` for the audited roles (`audit-db-grants.integration.test.ts:247-252`), so C10's real gap is database-level and unaudited roles. Say so.
- D4: the probe shows same-session effect. Other pooled sessions pick the change up through relcache and plancache invalidation at their next transaction. That is standard PostgreSQL behaviour, but it was not probed.

**F11 — Minor — design — [Adjacent] Severity: Minor — this may overlap with the Testing expert's scope**
- C11 says "evidence means the grant was set by a role subject to RLS in a test that passed". The record is taken at GUC-write time, with no link to the test outcome. A run with a failing test fails anyway, so this is a wording and semantics gap.

**F12 — Minor — prose — Derived claims**
- Objective says "three queries"; D2 says "four statements". The worker reads four things (tenant list, anchor, count, rows).
- C6 cites line numbers (58, 71, ...). I verified them against the `it(` lines and they match today. The plan could cite test names instead.

### Deploy and rollback (C3/C5/item 7)
- Role absent when the migration runs: the migration creates it NOLOGIN, so the audit fails until the bootstrap gives LOGIN. This is the F1 flow.
- Bootstrap before the migration (fresh RDS): `convergeRole` creates the role. The migration's "create when absent" skips it. The migration also grants EXECUTE, and bootstrap `grantRoutineExecute` guards on the function existing. Both orders converge.
- Rollback: the verify task definition rolls back to the `DATABASE_URL`-keyed revision, which still works as `passwd_app`. The ordering with `deploy.sh` and the Terraform `ignore_changes = [task_definition]` is otherwise consistent.
- The un-flip statement works as the migration role.

### Other facts the caller asked about
- `/api/maintenance/audit-chain-verify` and `src/lib/audit/audit-chain-verify.ts` run as `passwd_app`. The plan does not touch them and should not; one sentence stating that would help.

## Recurring Issue Check
- R1: Checked — no issue.
- R2: Checked — no issue.
- R3: Finding F3.
- R4: N/A — no event dispatch.
- R5: N/A — no new multi-step DB operations.
- R6: N/A — no deletes.
- R7: N/A — no e2e selectors.
- R8: N/A — no UI.
- R9: N/A — no fire-and-forget in transactions.
- R10: N/A — no module cycles introduced.
- R11: N/A.
- R12: N/A — no audit actions.
- R13: N/A.
- R14: Finding F3 (the restore runbook grant list omits the new role) and F4.
- R15: Checked — `current_database()` is used, nothing hardcoded.
- R16: Finding F1 (manifest LOGIN versus dev/CI NOLOGIN) and F6.
- R17: N/A.
- R18: Finding F3 (baselines) and F7.
- R19: N/A — no new exports in mocked modules.
- R20: N/A.
- R21: N/A — no subagent-driven changes.
- R22: N/A.
- R23: N/A.
- R24: Checked — role grants and the flip are separate migrations. Recorded in F8 (ordering).
- R25: Checked — C11 persistence: finding F5.
- R26: N/A.
- R27: N/A.
- R28: N/A.
- R29: Findings F4, F12.
- R30: N/A.
- R31: N/A — no destructive operation.
- R32: N/A — no new long-running artifact (the smoke check is covered by C3).
- R33: Checked — rls-smoke, e2e and ci-integration jobs reviewed; only ci-integration needs the role.
- R34: Checked — no deferrals found.
- R35: Checked — a manual-test artifact is in C12.
- R36: N/A.
- R37: N/A.
- R38: N/A.
- R39: N/A.
- R40: N/A.
- R41: Checked — C10 detection depends on the F10 edge cases.
- R42: Findings F3 and F9.
- R43: N/A.
- R44: N/A.
- R45: N/A.
- R46: N/A.
- R47: N/A.
- R48: N/A.
- R49: Finding F2.
- R50: Checked — verification preconditions are in the plan; no new finding.
- R51: N/A.
- R52: Checked — C5/C7 re-audit the control (D5, arm-order check).
- R53: N/A.
- R54: Checked — C5 control class declared.
- R55: N/A.
- R56: N/A.
- R57: N/A.
- RS1-RS6: N/A — out of scope.
- RT1-RT11: out of scope; one Adjacent note is F11.

```json
[
  {"id":"F1","severity":"Major","title":"Existing-RDS deploy order not executable; first deploy.sh applies the flip then stops at the audit","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null},
  {"id":"F2","severity":"Major","title":"E1 gate placed at merge, not at deploy; no mechanical guard; C6 grant fixes not on old tasks during rollout","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null},
  {"id":"F3","severity":"Major","title":"C2 member set omits migration-rls-dml baseline, transaction baseline, restore runbook, docker setup doc and count prose","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null},
  {"id":"F4","severity":"Major","title":"C2 misdescribes app-role-denied-privileges.json entries for worker roles","file":"scripts/checks/app-role-denied-privileges.json","line":null,"adjacent":false,"escalate":null},
  {"id":"F5","severity":"Major","title":"C11 evidence has no cross-fork aggregation mechanism or producer-consumer walkthrough","file":"vitest.integration.config.ts","line":null,"adjacent":false,"escalate":null},
  {"id":"F6","severity":"Minor","title":"Publisher log-group bullet has no stated home; scratch-DB URL-override purpose not carried by C6","file":"src/__tests__/db-integration/setup.ts","line":null,"adjacent":false,"escalate":null},
  {"id":"F7","severity":"Minor","title":"C3 under-specified: main() fallback at :588, NODE_ENV-qualified tests, envObject entry has no consumer","file":"scripts/audit-chain-verify-worker.ts","line":588,"adjacent":false,"escalate":null},
  {"id":"F8","severity":"Minor","title":"Flip migration attribute list omits PARALLEL SAFE; migration ordering not pinned","file":"prisma/migrations/20261019000000_rls_bypass_admits_report_mode/migration.sql","line":12,"adjacent":false,"escalate":null},
  {"id":"F9","severity":"Minor","title":"Trigger and invoker-function bodies not enumerated in C8/C11 (question)","file":"prisma/migrations/20260227050000_tenant_id_trigger_defaults_phase8/migration.sql","line":196,"adjacent":false,"escalate":null},
  {"id":"F10","severity":"Minor","title":"C10 does not specify SHOW failure handling, per-role keying, or what audit-db-grants already detects","file":"src/lib/db/pool-factory.ts","line":177,"adjacent":false,"escalate":null},
  {"id":"F11","severity":"Minor","title":"[Adjacent] C11 evidence recorded at GUC write, claimed as 'in a test that passed' (Testing expert's scope)","file":null,"line":null,"adjacent":true,"escalate":null},
  {"id":"F12","severity":"Minor","title":"Derived claims: 'three queries' vs four statements; line-number citations in C6","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null}
]
```

## Security expert

## Security review, Round 1: verify-worker-readonly-role-rls-enforce-plan

Read-only review against the worktree code. No Critical findings. Five Major and three Minor.

Confirmed from code, so the plan can keep it:
- `metadata` is required for verification. `audit-chain-verify.ts:134-147` feeds it into `buildChainInput` as the hashed payload, so withholding it would break the verifier.
- Withholding the other `audit_logs` columns does gain something. `user_id`, `action`, `target_id` and the IP columns are not readable by the new role.
- The eleven-column count is right: seven on `audit_logs`, three on `audit_chain_anchors`, one on `tenants`.
- `audit-db-grants.mjs` already audits `pg_db_role_setting` and `pg_auth_members`, so a role-level `client_min_messages` and inherited membership are covered for audited roles.
- `app-role-denied-privileges.json` already has `passwd_anchor_publisher` entries, so C2's "as for the publisher" is accurate.

## Findings

### S1 [Major, design] Role creation does not converge a pre-existing role (R14, R15)
- **Problem:** C1 says "created when absent". The template migration `20260502000000_audit_anchor_publisher_phase2` §5 wraps `CREATE ROLE` in `IF NOT EXISTS`, then only revokes schema and default privileges. A pre-existing `passwd_audit_chain_verifier` keeps its attributes (LOGIN, BYPASSRLS, SUPERUSER, REPLICATION), its table and sequence grants, and its role memberships. The migration adds the D2 columns on top.
- **Evidence:**
  - The template migration's `IF NOT EXISTS ... CREATE ROLE ... NOLOGIN NOSUPERUSER NOBYPASSRLS` followed by `REVOKE ALL ON SCHEMA`.
  - `bootstrap-rds-roles.mjs` converges attributes (`ROLE_ATTRS`, `ROLE_ATTR_EXPECTATIONS`) only on the RDS path, not on the dev, CI or compose path.
  - Invariant C1 is labelled "schema-enforced" but has no in-migration assertion.
- **Impact:** over-privilege direction, which is Critical for R14 if it ever happens. Likelihood is low because the name is new, but the invariant claims more than the migration delivers.
- **Fix:**
  1. Add `ALTER ROLE ... NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`. On RDS the migration role may be unable to clear superuser-only attributes, so assert them instead.
  2. Add `REVOKE ALL` on all tables, sequences and routines in `public` from the role, before the column grants.
  3. Strip memberships.
  4. End with a `DO` block that raises if any attribute, grant or membership falls outside the D2 set.
- **Pair the deny side with an allow case:** a pre-seeded over-privileged role must be narrowed, and a fresh role must still end with exactly the eleven columns.
- **Red-prove:** one mutation per clause.

### S2 [Major, design] Merging is the production flip, and the only control is prose (D1, E1, C12)
- **Problem:**
  - Under D1 the flip migration deploys with the release. The E1 gates are a sentence in the PR body, and nothing enforces them.
  - Plain `docker compose up` (the `migrate` service) flips every self-hosted install the same way. Those installs have no CloudWatch alarm, and the publisher and verify worker have no compose service (alerts.md "Not covered"). The canary and zero-window gates are AWS-only.
  - #947, a pure least-privilege improvement, is held hostage to the #921 production window.
  - Report-mode zero says nothing about plan-dependent reach (D6 in issue #921). A statement's reach depends on the plan, so a production stats or plan change after the zero window can start refusing something never reported.
- **Evidence:**
  - D1's own "What the alternative satisfied" paragraph.
  - `rls_bypass_admits` raises only when the policy evaluates the call.
- **Impact:** availability failure of production paths with no machine-checked gate. Most likely to break:
  1. Paths no test drives and that run only in production: Auth.js callbacks in `auth.ts`, SCIM, extension and MCP replay-revocation (`oauth-server.ts`), emergency-access flows.
  2. The outbox drain. If its grant is short, audit events pile up while the web app stays healthy.
  3. SECURITY DEFINER routines owned by the RDS NOBYPASSRLS migration role: `audit_log_purge`, `team_member_key_prune`.
  4. Operator scripts on RDS: `tenant-domain` and the migrate scripts.
  5. Ad-hoc SQL runbooks run as the table owner.
- **Fix, recommended:** ship #947 and the C6/C7 enforcement tests now, and give the flip migration its own later release.
  - Run the one `CREATE OR REPLACE` as a post-migrate step in the ephemeral `ci-integration` and `rls-smoke` databases, so CI is permanently the enforce pass.
  - `setup.ts` still refuses to run unless `rls_bypass_enforced()` is true. A local developer therefore needs that statement once.
  - Cost: that statement, plus a note in the dev docs. It drops D1's selector, marker and scratch-DB machinery.
  - What D1 silently satisfied that this does not: "the shipped migration equals the tested state". The follow-up release must re-run the suite.
- **Fix, if D1 stays:**
  1. Mark the release as breaking for release-please.
  2. Put the E1 sign-off in a checklist artifact that the release PR links.
  3. Say explicitly that self-hosted installs have no canary and no alarm.

### S3 [Major, design] Un-flip and flip state are invisible, and the un-flip persists silently (C5, D4)
- **Problem:** the un-flip is a hand-run `CREATE OR REPLACE`.
  - It leaves no row in `_prisma_migrations`, so checksum and drift detection do not see it.
  - A later `migrate deploy` does not revert it.
  - It is not an audit event (DDL by the migration role is not logged).
  - Nothing reads the function body at runtime or in `audit-db-grants.mjs`. A forgotten un-flip leaves enforcement off while C12's rewritten docs say "enforced".
- **Who can run it:** the function owner (the migration role, or a superuser). An attacker holding that role can already disable RLS or alter policies, so this is no worse than today. The new exposure is stealth and forgetting, not capability.
- **Impact:** a fail-closed control can be turned off with no detection.
- **Fix:**
  1. `audit-db-grants.mjs` asserts `rls_bypass_enforced()` is true, and also asserts the function's owner and EXECUTE ACL. The un-flip is the allow case, passed via an explicit flag.
  2. Make the un-flip a committed forward migration, or a script that sets `COMMENT ON FUNCTION` with date, reason and operator, which the audit reads. That keeps the "mode is migration-owned" rule honest.
  3. Emit a startup or heartbeat log line when `rls_bypass_enforced()` is false, wired to the existing `RlsBypassNotGranted` alarm. Each worker already runs `validateWorkerEnv` and each pool has a `pool.on("connect")` hook, so there is a place to add it.
  4. The forbidden-pattern carve-out for `docs/operations` is acceptable only with this detection.

### S4 [Major, design] Best-effort revocation under bypass becomes all-or-nothing at the flip (C9, R42)
- **Problem:** `invalidateUserSessions` runs one transaction over ten models. A single refused table rolls back every revocation. The plan derives the member set by callee name only, and its only change is a log line in `vault/rotate-key`.
- **Evidence (member set, grep and read):**
  - **Already fail the request:**
    - `change-passphrase/route.ts:129-146` returns `SESSION_INVALIDATE_FAILED`.
    - `recovery-key/recover/route.ts:231-250` returns `SESSION_INVALIDATE_FAILED`.
  - **Uncaught (500 after the wipe has committed):** `vault/reset` and `vault/admin-reset`.
  - **Explicitly "fail-open" (log and continue):**
    - SCIM `Users/[id]` at lines 189, 298 and 367.
    - `teams/[teamId]/members/[memberId]/route.ts:312`.
  - **Swallowed with no log:** `vault/rotate-key/route.ts:244-247`, `.catch(() => null)`. It returns 200 with `invalidationFailed`.
  - **Not matched by the callee grep:** `vault/delegation/route.ts:271-282`, a warn-only revoke of the old delegation session under bypass.
- **Which sites become newly fail-open on refusal:**
  - rotate-key
  - the SCIM deprovision sites
  - team-member removal
  - the delegation revoke
  - Key rotation exists to kill tokens minted under the old key. SCIM deactivation is a security event the IdP will not retry.
- **Impact:** after the flip, one missing grant leaves a rotated or deprovisioned user's sessions and MCP/API/operator tokens alive. Logging does not close that.
- **Fix:**
  - **rotate-key:** do not just log. Follow its true siblings: log at error level, then return `errorResponse(API_ERROR.SESSION_INVALIDATE_FAILED)` as change-passphrase and recover do. Keep `invalidationFailed` in the audit row.
  - **SCIM and team removal:** either make a refusal durable and retried, or confirm that a retry re-runs invalidation. Today `needsSessionInvalidation` follows the state change, so a retry may skip it.
  - **Member set:** re-derive it from "withBypassRls inside a try/.catch that does not rethrow, writing revocation or deletion state", not from the callee name. Then say which sites change behaviour.
  - Keep C8's passwd_app cell as the allow case.

### S5 [Major, design] The verifier can starve other workers' advisory locks, and the role has no limits (R14, #947 least privilege)
- **Problem:** the role can call `pg_advisory_lock*`. PUBLIC holds EXECUTE on those functions, and a role-level REVOKE cannot remove it.
- **Evidence:**
  - Keys are constants in public source: `hashtext('audit-anchor-publish')`, and `advisoryXactLock(key)` in `tenant-rls.ts:247-257` for api-keys, mcp-clients, `mcp/register` and bridge-code.
  - `worker-policy-manifest.json:125` says the publisher treats a wait past `lock_timeout` as `lock_held`, "not a failure". Holding that lock stalls external anchoring silently.
  - No role-level `statement_timeout`, `idle_session_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` or `CONNECTION LIMIT` appears in any bootstrap or migration (my grep found none in `bootstrap-rds-roles.mjs`).
  - Also reachable by any role: temp tables and `lo_*` large objects (storage and connection holding).
- **What compromise yields:**
  - The role can set its own `app.bypass_*` GUCs (SC2). It can read the seven `audit_logs` columns, including `metadata`, for every tenant. It can read all tenant ids and every anchor row.
  - It cannot read any other table or column, and cannot write.
  - That is far less than `passwd_app` today.
  - It can still stall the anchor publisher without being noticed.
- **Fix:**
  - **Migration:** set `ALTER ROLE ... CONNECTION LIMIT` and role-level `idle_session_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` and `statement_timeout`. Check these do not collide with the worker's own `SET LOCAL` budget (`TX_BUDGET`, 60 s).
  - **`audit-db-grants.mjs` item 10:** allow-list exactly these settings for the role, and keep failing on `client_min_messages` and `app.*`.
  - **Alert:** on a run of consecutive `lock_held` outcomes from the publisher.
  - **If role-level settings are impractical on RDS:** record that as a residual risk in C1.
- **Allow case:** a full-size tick still completes within the limits.

### S6 [Minor, prose] Control-class and doc claims stronger than the code (R49)
- **Problem:**
  - C1 labels the role an "enforceable boundary". The boundary is table and column privilege only. Tenant scope is not bounded, because the role sets its own bypass.
  - C12 rewrites `security-review.md`, `tenant-boundary-matrix.md` and `threat-model.md`. Wording must not suggest more than "fail-closed gate against code using `setBypassGucs`".
- **Evidence:**
  - C5 itself states the SC2 limit.
  - `enforce_tenant_id_from_context` returns early on `app.bypass_rls = 'on'` regardless of the grant (migration `20260227050000_tenant_id_trigger_defaults_phase8`). The flip does not touch that trigger.
  - Non-RLS tables, `FORCE`-less owners and SECURITY DEFINER bodies owned by an RLS-exempt owner (dev and CI) are also not covered.
- **Fix:**
  - State the tenant-scope limit in C1's control class.
  - Add a "not covered by the flip" list to the rewritten docs: the trigger short-circuit, definer owners, superuser or BYPASSRLS connections, tables without RLS, code that writes `app.bypass_tables`, and role- or database-level `app.*` defaults. The last is partly covered by audit item 10.
  - Say that `metadata` is a tenant-readable narrative sink readable cross-tenant by this role.

### S7 [Minor, design] D5's worst case is understated
- **Problem:** the plan says that if the OR-arm order changed, an ungranted bypass with a tenant id "would be admitted to that tenant's rows only". That omits two things.
  - If the tenant arm is evaluated first and is true, `rls_bypass_admits` is never called. There is then no refusal and no WARNING either, so the miss is silent as well as admitted.
  - The publisher passes `SYSTEM_TENANT_ID` (`audit-anchor-publisher.ts:397`, 432, 576, 850; `setBypassGucs` default is NIL otherwise). So the worst case for those calls is the sentinel's unattributable audit rows, which `assertOpenableTenantContext` treats as the most sensitive set.
- **Fix:** keep the catalog check and the D5 cell. Add the sentinel-tenant case to the D5 block in `rls-cross-tenant-verify.sql`, and reword D5 accordingly. The `[E-RLS-ARM-ORDER]` check should read the whole arm structure, not only match text for "bypass arm textually first".

### S8 [Minor, design] The C10 signal self-clears, and a swallowed refusal has no counter when WARNINGs are suppressed (D6)
- **Problem:**
  - `rls.bypass_report_channel_suppressed` is logged once per process per role, onto the same metric and alarm as reports. `monitoring.tf` uses `evaluation_periods = 1`, period 300, `treat_missing_data = notBreaching`. A standing misconfiguration pages once and returns to OK after five minutes. `alerts.md`'s recovery text ("find the code path that serves `purpose`") is also wrong for this case.
  - The check is connect-time only. A later session-level `SET client_min_messages` by code that can issue SQL is not seen. That is within SC2, but the plan does not say so.
  - After the flip, WARNING suppression plus a catch that swallows the 42501 leaves no signal.
- **Not a problem:** the log line carries no secrets, since it holds only a role name and a level.
- **Fix:**
  - Give suppression its own metric and alarm, or re-emit it periodically, for example once per tick or hour.
  - Add a metric filter for `errorLogFields` `code = "42501"` on the best-effort catch logs. `errorLogFields` (`src/lib/logger/error-fields.ts`) emits a structured `code` that `pgErrorCode` resolves to 42501 through the nested P2010. That gives a second channel that does not depend on the WARNING.
  - Document the pooler caveat: RDS Proxy and pgbouncer connection pinning, and startup-parameter handling.

## Items asked about that I found no finding for

- **Secrets and password handling (item 2):**
  - The SCRAM verifier and statement-text suppression exist for `bootstrap-rds-roles.mjs` and for the initdb template. The `04-create-retention-gc-worker-role.sql` template shows the full pattern: statement-text SETs, `\getenv`, empty-password guard, NOLOGIN fallback.
  - C2 must clone that template, not the CI `ALTER ROLE ... PASSWORD '${...}'` line (a test value, acceptable only in CI).
  - Production has no `DATABASE_URL` fallback via `NODE_ENV=production` (Dockerfile:166), same as the publisher.
- **C11 harness hook (item 6):** it is test-only. As written it records GUC purpose, table list and `current_user`, not bind parameters. Ensure it lives only under `src/__tests__/db-integration` and is never imported from `src/`. If it ever records `query` text or `values`, that becomes a logging-secrets finding.
- **Dropped from the issues:** nothing security-relevant. #921's "refuse to start if `.env.local` overrides a `*_DATABASE_URL`" is moot under D1. The publisher log-group and filter precondition is already satisfied in `monitoring.tf:71-79`.

## Recurring Issue Check

- R1 Checked, no issue.
- R2 Checked, no issue.
- R3 Checked. Finding S4: the member set was derived by callee, and the propagation across best-effort catches is incomplete.
- R4 N/A.
- R5 Checked. Finding S4: the single-transaction all-or-nothing revoke.
- R6 N/A.
- R7 N/A.
- R8 N/A.
- R9 Checked, no issue.
- R10 Checked, no issue.
- R11 N/A.
- R12 N/A.
- R13 N/A.
- R14 Finding S1 and S5. Column grants are minimal and sufficient for the four statements. The residual capabilities are in S5.
- R15 Finding S1 (a pre-existing role is not converged).
- R16 Checked. The CI and initdb surfaces are listed in C2. Finding S1 covers the dev and CI path not converging attributes.
- R17 Checked, no issue.
- R18 Checked. The C2 member set is sound. `app-role-denied-privileges.json` entries are needed for the new role (the publisher has them), and `AUDITED_ROLES` must add it (`audit-db-grants.mjs:59-63`).
- R19 N/A.
- R20 N/A.
- R21 N/A.
- R22 N/A.
- R23 N/A.
- R24 Checked. The flip migration is a single statement. Finding S2 covers the timing.
- R25 N/A.
- R26 N/A.
- R27 N/A.
- R28 N/A.
- R29 Checked. The orchestrator's probes were not re-run (read-only constraint). The code-derived facts above were re-derived by grep and Read.
- R30 N/A.
- R31 N/A.
- R32 N/A.
- R33 Checked, no issue.
- R34 N/A.
- R35 Checked. The plan includes a manual-test artifact in C12.
- R36 Checked, no issue.
- R37 N/A.
- R38 Finding S3: the un-flip persists silently with no reset or detection path.
- R39 N/A.
- R40 N/A.
- R41 N/A.
- R42 Finding S4: the member set must be derived by the "write revocation state in a non-rethrowing catch under bypass" class, not by callee name.
- R43 Checked. The flip narrows the boundary, and the new role is narrower than `passwd_app`.
- R44 N/A.
- R45 N/A.
- R46 N/A.
- R47 Checked. The refusal is adjudicated by the PostgreSQL policy evaluator, not by surface-form matching.
- R48 Checked, no issue.
- R49 Finding S6.
- R50 Checked. Finding S2 covers the plan-dependent reach that the zero window does not verify.
- R51 N/A.
- R52 Checked. Widening the control to enforcement is re-audited by C6 and C8. Gaps are in S4.
- R53 N/A.
- R54 Checked. The bypass grant is transaction-local (`set_config(..., true)`). Finding S7 covers the sentinel-tenant case.
- R55 Checked, no issue.
- R56 N/A.
- R57 N/A.
- RS1 N/A.
- RS2 N/A.
- RS3 N/A.
- RS4 Checked, no issue. The plan's committed test passwords follow existing CI practice.
- RS5 N/A.
- RS6 N/A.

```json
[
  {"id":"S1","severity":"Major","title":"Role creation does not converge a pre-existing role (attrs, table grants, memberships)","file":"prisma/migrations/20260502000000_audit_anchor_publisher_phase2/migration.sql","line":null,"adjacent":false,"escalate":null},
  {"id":"S2","severity":"Major","title":"Merge is the production flip; doc-only gate; self-hosted installs have no canary; #947 coupled to #921","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null},
  {"id":"S3","severity":"Major","title":"Un-flip and flip state are undetected; hand-run CREATE OR REPLACE persists silently","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null},
  {"id":"S4","severity":"Major","title":"Best-effort revocation becomes all-or-nothing at the flip; rotate-key should fail like its siblings; member set derived by callee","file":"src/app/api/vault/rotate-key/route.ts","line":244,"adjacent":false,"escalate":null},
  {"id":"S5","severity":"Major","title":"Verifier role can starve publisher advisory lock; no role-level timeouts or connection limit","file":"src/lib/tenant-rls.ts","line":257,"adjacent":false,"escalate":null},
  {"id":"S6","severity":"Minor","title":"C1 'enforceable boundary' and C12 doc rewrites overclaim; tenant scope unbounded, non-covered list missing","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null},
  {"id":"S7","severity":"Minor","title":"D5 worst case understated (silent, and SYSTEM tenant for the publisher)","file":"src/lib/tenant-rls-grants.ts","line":261,"adjacent":false,"escalate":null},
  {"id":"S8","severity":"Minor","title":"C10 signal self-clears on shared metric; swallowed refusal has no counter when WARNING is suppressed","file":"infra/terraform/monitoring.tf","line":144,"adjacent":false,"escalate":null}
]
```

## Testing expert

Testing-perspective review, round 1 (full), of verify-worker-readonly-role-rls-enforce-plan.md. Read-only; nothing was run. The Finding Floor and Remedy Floor text could not be extracted and read in full; the common-rules.md extraction came back truncated, and only the Finding Floor was read. Pattern names come from the digest.

# Findings

## T1. `expectBypassNotices` cannot carry a refusal cell, and C6 does not change it (Major, design)
- **Problem.** C6 turns the report cells into "statement rejects with 42501 + report taken". The helper is `await fn(); return buffer.splice(before);`, so when `fn` throws, the splice never runs.
  - The WARNING stays in the sink buffer and setup.ts's `afterEach` fails the test with "RLS bypass reached tables outside its grant", whatever the cell asserts.
  - The cell therefore has to catch inside `fn`, or the helper has to splice in a `finally` and still rethrow.
  - Callers that pass the whole rejecting call are affected: rekey-writers:1052, tenant-departure:1961 (both via `asApp`), the prune cell at :373 and share-departure:874.
- **Evidence.**
  - helpers.ts:901-905 (the helper).
  - setup.ts:134-146 (`failOnReports`).
  - team-key-rekey-writers:1052-1058, where `asApp(...)` is passed straight in.
- **Impact.** Every converted cell reds for the wrong reason, or an author wraps the call in an unasserted `.catch`, which is RT8 vacuity.
- **Action.** Make the helper's contract explicit. Suggested form: `expectBypassRefusal(fn)` returns `{ notices, error }`, splices in `finally`, and requires a thrown error. Name that helper in C6 and give it its own unit cell.

## T2. After a 42501 the transaction is aborted; C6's "write absent" and "allow twin" need a concrete mechanism per cell family (Major, design)
- **Problem.**
  - Raw-pg cells: team-member-key-prune:520-526 runs the refused call and then asserts the notice list, with `ROLLBACK TO SAVEPOINT` only afterwards. Once the call rejects, the rollback line is unreachable and every later statement in the cell gets 25P02. The same shape applies to `asApp`/`runBlock` cells (rekey-writers:1048-1058, tenant-departure:1957-1965).
  - Prisma interactive cells: share-departure:870-876 runs the "positive control" in the middle of a loop, followed by `settings()` queries and `throw ROLLBACK`. After a refusal those queries hit 25P02, and `.rejects.toBe(ROLLBACK)` would see the 42501 instead.
  - Script cells: departed-member-operator-scripts:501 and :816 use `runScript(mutated).catch(() => undefined)`. That swallows the error. The cell would stay green even if the refusal were not 42501 or not about `removed`.
- **Evidence.** The line numbers above; `runScript` rolls back in its `catch` at :256-262.
- **Impact.** "Write absent" asserted inside the aborted transaction is vacuous, and a later "refused" can be a 25P02 artifact.
- **Action.**
  - Require every refused statement to run under `SAVEPOINT` with `ROLLBACK TO` in raw-pg cells.
  - Make the refusal the last statement in Prisma cells.
  - Read "write absent" through `ctx.su` after the transaction has ended.
  - In the script cells, capture the error and assert `code === "42501"` plus `RLS_BYPASS_NOT_GRANTED: <removed>`.
  - team-member-key-prune:557 asserts `{enforced:false,…}` in the post-state; it flips to `true` and is the cell the C5 forbidden pattern hits. The plan does not name it.

## T3. C1's invariant and its first mutation row are not enforced by any CI test (Major, design)
- **Problem.** The mutation row "add SELECT on a twelfth column → `audit-db-grants` against the manifest" has no CI test behind it.
  - `audit-db-grants.integration.test.ts` T1 deliberately runs against a manifest generated from the same database, not the committed `db-grants-manifest.json`; the committed one is only checked at deploy by the migrate task.
  - C1's acceptance ("manifest regenerated with `--write`…") is therefore a manual step.
  - C4's denial cells probe one column outside D2 and some tables, so a twelfth column on `audit_logs` or `tenants` is not caught.
- **Evidence.** audit-db-grants.integration.test.ts:115-135 (the comment says the committed manifest is not asserted).
- **Impact.** The "reads the eleven columns and nothing else" claim, which is the point of #947, can silently widen in CI.
- **Action.** Add an integration cell that asserts the verifier's effective privileges exactly. Enumerate every column of every public table with `has_column_privilege`, and tables, sequences and functions with their `has_*_privilege` counterparts, then compare to the D2 set. Redo the mutation row against that cell.

## T4. C10's on-connect read will trip setup.ts's concurrent-query backstop, and the existing fakes cannot take it (Major, design)
- **Problem.**
  - pg-pool emits `connect` synchronously and immediately hands the client to the waiting caller (`node_modules/pg-pool/index.js:337-357`). A query issued in the connect handler is therefore still in flight when the caller's first query arrives.
  - setup.ts's `Client.prototype.query` wrapper records any query issued while `_activeQuery != null` or the queue is non-empty (setup.ts:178-194). The only exemption is Prisma's join-children frame, so every integration test would fail with "pg ran two queries at once".
  - The plan names this as a Risk but gives no mechanism.
  - Unit side: `pool-factory.test.ts:181-190` emits `connect` with an EventEmitter lacking `.query`, which would throw. The handler also needs a `.catch`, or a dropped connection is an unhandled rejection.
- **Impact.** Whole-suite red, or an exemption bolted into the harness after the fact (RT9-style drift).
- **Action.** Decide the mechanism in the plan.
  - Option 1: do the read lazily, before the first checkout is returned, by wrapping `pool.connect`.
  - Option 2: exempt the factory's own read by exact SQL text in the backstop, with a self-control in setup.ts like the existing positive control.
  - Also list the fakes to update (`pool-factory.test.ts`) and require a test that a failed read does not reject unhandled.

## T5. C11's mechanism is unspecified and not deterministic as written (Major, design)
- **Problem.**
  - "Observes each bypass GUC write" has no mechanism. `setBypassGucs` is production code, and the bypass is also set by raw `set_config('app.bypass_rls'…)` in migration blocks and scripts.
  - Recording `current_user` at write time misses `SET LOCAL ROLE` cells (`enterBypassRole`, share-departure:853) if it reads `client.user`.
  - A role read on the same connection from inside the `Client.query` wrapper would trip the backstop (see T4).
  - `isolate: true` with `pool: forks` (vitest.integration.config.ts) means each file has its own module state.
    - There is no `globalSetup`, so the record needs per-file append to a shared path and a post-run aggregator.
    - Nothing distinguishes a full run from a filtered one: no vitest API for it, and CI always runs unfiltered, so the env flag cannot tell a skipped or failed file from a full run.
  - `it.skipIf` cells (for example tenant-claim-cli's `SKIP`) silently remove evidence.
  - The mutation table has only one direction ("grant removed from list while unexercised"). The opposite direction (a listed grant that now has evidence) and the recorder itself have no failing proof (RT7).
  - Wiring is unnamed: no workflow step is named, and no non-DB unit test run by `app-test` is planned for the aggregator.
- **Action.** Specify the recorder, for example a hook on the existing `Client.prototype.query` that parses the `set_config` parameters. Specify the role lookup (a cached once-per-user probe on a separate client), the JSONL file path, and an aggregator script run as a step after `npm run test:integration` in `ci-integration.yml`. Cover the aggregator with a pure-function unit test with fixtures for both directions. Treat any skipped file as "not full".

## T6. C11's "evidence" overstates what E1 and the Risk section lean on (Major, design; R49/D6)
- **Problem.**
  - A recorded GUC write proves only that some passed test set the grant as an RLS-subject role. It does not prove a production path ran under it (a test can set `BYPASS_GRANT.X` and run a hand-written statement; `inRetentionSweepTx(client, fn, grant)` takes test-authored `fn`).
  - Nor does it prove each table of the grant was examined. D6 of the prior deviation says refusal depends on the plan, so a table that is empty in the cell, or a pk lookup that finds nothing, gives no signal.
  - The plan's "bounded by C11's list" in E1 and in the Risk section is therefore weaker than stated.
- **Impact.** An unproven grant reads as proven (R49, claim stronger than the implementation).
- **Action.** Either narrow the claim in C11, E1 and the PR body to "grant set by an RLS-subject role in a passed test". Or count a write only when the setting frame is a non-test `src/` caller, and require the cell to have seeded a row in each table of the grant. State that the remaining gap is carried by E1.

## T7. C7: the `[E-RLS-ENFORCED]` negative case collides with the function rule, and 4b needs a different loop structure (Major, design)
- **Problem.**
  - `rls-cross-tenant-negative-test.sh` mutates throwaway tables' policies. To prove `[E-RLS-ENFORCED]` can fail it must redefine `public.rls_bypass_enforced()` to return false. `check-bypass-rls.mjs` (function rule, ~:2973-3056) refuses any `CREATE [OR REPLACE] FUNCTION` outside `prisma/migrations`, apart from `FUNCTION_RULE_ALLOWLIST`; the only entry today is case 9's probe (:3008).
  - C5's own forbidden pattern says the same. The plan lists neither an allowlist entry nor an alternative, so the row "`[E-RLS-ENFORCED]` can fail" cannot be built as planned. Cases 15/16 already mutate real policy behind `RLS_NEGATIVE_MUTATE_REAL_POLICY`, which is a precedent for a scoped allowlist entry with a `why`.
  - Block 4b today is one flat `DO` loop where `EXECUTE format('SELECT count(*)…')` and `n = 0 → E-RLS-REPORT` are the assertions (rls-cross-tenant-verify.sql:~790-815). A refusal aborts the whole `DO`.
    - It needs a per-iteration sub-block with `EXCEPTION WHEN insufficient_privilege`. The savepoint reverts the withheld `set_config`, and the WARNING is already sent to the client, so `rls-verify-run.sh` (merged stdout+stderr) still sees it.
    - The no-exception branch must `RAISE` a new code.
  - The new codes (4b per-table refusal, the D5 block, `[E-RLS-ARM-ORDER]`, `[E-RLS-ENFORCED]`) have no mutation row except two. The D5 block and 4b's "no exception" arm have none.
- **Action.**
  - Add the allowlist entry (scoped file, restore in the same case) for the flip-back case, or drop that case and say what proves the assertion fails.
  - Spell out the sub-block shape in C7.
  - Add mutation rows for 4b's no-refusal arm and for the D5 block.

## T8. C8 definer cells: for two of the three routines the refusal twin cannot discriminate the body from the guard (Major, design)
- **Problem.**
  - `audit_log_purge` and `audit_log_tenant_migrate` start with `rls_bypass_admits('audit_logs')` (migration 20261021000000, lines 22-27 and 40-45), and their body touches only `audit_logs`. "Refused under a grant missing a table its body scans" is therefore always the guard's explicit raise, and the owner swap adds nothing to the refusal arm.
  - The row "a definer body's grant drops a scanned table" is meaningful only for `team_member_key_prune`.
  - For the two audit routines the owner-swap cell proves only the allow arm: the body runs as a NOBYPASSRLS owner. That needs the probe role to hold SELECT/UPDATE/DELETE on `audit_logs`, and `FORCE ROW LEVEL SECURITY` taken under `ALTER TABLE` (ACCESS EXCLUSIVE on the shared database, so stop the workers first).
- **Impact.** The mutation table over-claims.
- **Action.** Reword C8 and the row: for the two audit routines, assert allow arm plus write present/absent. Keep the refusal pair as the guard, and say so. The prune cell (team-member-key-prune:~441-560) already is the real multi-table pair; extend it rather than rebuild it. Seed an `audit_logs` row in each cell so the allow arm examines a row.

## T9. C8 operator-script cells: the "pair under a narrower grant on the same connection" is not available for the script's own statements (Major, design)
- **Problem.**
  - The grants are fixed at the call sites inside `tenant-domain.ts` (`BYPASS_GRANT.TENANT_CLAIM_LIST` etc.) and in the migrate scripts. A test cannot hand the script a narrower grant without mocking `@/lib/tenant-rls-grants`, or without rewriting the SQL by hand, which is a detached control and not the script's statements.
  - The CLI test reads `MIGRATION_DATABASE_URL` and only stubs it when unset (tenant-claim-cli.integration.test.ts:105-111). CI sets it to the postgres superuser, so a NOBYPASSRLS run needs an explicit `vi.stubEnv` to a probe login role.
  - Each of the ten `TENANT_*` grants needs its own set of probe privileges, since `passwd_app` lacks some of them (for example the column-scoped `tenant_claim_events` insert).
  - The two script cells and the `invalidateUserSessions` cell have no row in the mutation table.
- **Action.**
  - Specify the mechanism: `vi.mock("@/lib/tenant-rls-grants")` with `importOriginal` that narrows one named member, and assert 42501 naming the dropped table.
  - Seed a row in each of the ten `USER_SESSION_INVALIDATION` models, since refusal needs an examined row.
  - Add one mutation row per script and one for `invalidateUserSessions` (drop a model from the grant).
  - Budget for it: the tenant-domain file is 3,500 lines, all run as superuser today.

## T10. R32/R35: no real boot of the verify worker under the new role, and the manual-test artifact is a one-line bullet (Major, design)
- **Problem.**
  - The smoke map change is only the URL user in `worker-bundle-smoke.json`, and the boot it runs is `--validate-env-only`, which never connects.
  - C4 drives `runTick` and `verifyTenantChain` through a pool but never `main()`. `audit-chain-verify-worker-env.test.mjs` runs the loop against a refused port.
  - The ECS-shaped failures the new role introduces are in `main()`: the production URL with no `DATABASE_URL` fallback, the pool, the first tick under the role.
  - C12's "manual-test artifact" has no content or acceptance.
- **Action.**
  - Add an integration cell that spawns the worker (`tsx` like the env test, or the built bundle) with only `AUDIT_CHAIN_VERIFY_DATABASE_URL` set to the verifier. It waits for the `audit-chain-verify-heartbeat` line (the declared ready signal) with `erroredTenantCount: 0`, then sends SIGTERM and expects "shutdown clean".
  - Specify the manual-test file's steps: bootstrap the role, secret key, deploy order, expected heartbeat, and a deliberate failure (an unset key keeps the previous task).

## T11. Environment parity details the plan leaves open (Minor, design)
- **Problem.**
  - Local: the role is NOLOGIN until given a password (E5), so the first verifier cell fails with pg's "not permitted to log in" on the first query. That is loud, not a silent skip, but unhelpful.
  - CI: the password env and a `passwd_audit_chain_verifier_pass` fallback in `helpers.ts getConnectionString` have to match, as the anchor publisher's do. `ci-integration.yml`'s `ALTER ROLE` step runs after `migrate deploy`, so the order is fine.
  - rls-smoke creates `passwd_app` before the migrations and never logs the new role in, so the role's grants get no coverage there. T3's cell therefore has to live in `ci-integration`.
  - `infra/postgres/**` is in neither path filter (ci.yml `app`, ci-integration), so an initdb-only change triggers neither the integration job nor rls-smoke.
  - setup.ts's `enforced()==true` precondition holds in the integration job, since the flip ships in the same migration set.
  - The `pre-pr.sh` integration step runs only on `refactor/` branches, so this `fix/` branch never runs it locally.
- **Action.**
  - Add a `rolcanlogin` preflight with an actionable message when a verifier cell is first built; do not use `skipIf`.
  - Add the password to the `helpers.ts` fallback and `ci-integration.yml`.
  - Add `infra/postgres/**` to the filters.
  - Tell the PR body to run `npm run test:integration` by hand, after stopping the workers.

## T12. C5's forbidden patterns have no owner or mutation row (Minor, design)
- **Problem.**
  - `CREATE (OR REPLACE )?FUNCTION public.rls_bypass_enforced` outside migrations is already covered by `check-bypass-rls`'s function rule, so the plan restates an existing gate without saying so.
  - The `enforced: false` in `src/__tests__` pattern names no gate. It is a surface-form grep (R47: `enforced:false`, `enforced : false`, a computed key evade it), and no mutation row proves it fires.
- **Action.** Say which existing gate owns the first pattern. For the second, either add a gate with a self-test or drop it; T2's cell at team-member-key-prune:557 is its only current hit.

## T13. Some planned cells are order-dependent (D6), and the plan has no "mandatory checks" step (Minor, design)
- **Problem.**
  - team-member-key-prune:366-379 ("runs under the production grant, with no report" and the report cell) call `team_member_key_prune(1)` without seeding. They depend on team-member-key rows left by earlier cells or other tenants. Under `-t` or a lone run the "no report" twin is vacuous and the refusal cell would not refuse.
  - The plan lists no `npx vitest run` / `npx next build` / `npm run test:integration` verification, which the repo's Mandatory Checks require.
- **Action.** Seed a team in each of the two cells, or make them call a seeding helper. Add the three commands to the plan's verification section.

## T14. Adjacent: arm order and metadata read (Minor, design, [Adjacent])
- [Adjacent] Severity: Problem — this may overlap with the security expert's scope. D5 admits PostgreSQL does not promise OR-arm evaluation order. C7's textual check and cell pin only today's observed order. If a planner change moved the tenant arm first, a bypass with a tenant id would be admitted to that tenant's rows without refusal. From the testing side, the check is detection at CI time on this planner only.
- [Adjacent] Severity: Problem — this may overlap with the security expert's scope. Under the sentinel-read bypass grant the verifier reads every tenant's `audit_logs.metadata`. `metadata` is a column of D2, so the decision to hold that column is security's, not testing's.

# Recount of C6's member set (code minus plan)

Recomputed with `expectBypassNotices(`, `collectNotices(`, `.on("notice"`, `app.bypass_rls`, `setGucs(`, `setTestBypass(`, `enforced`, and the word "report".

- `expectBypassNotices(` call sites outside the plan's list: none that change at the flip. The extra hits are the allow-twin cells that must stay green: rls-bypass-grants:60 is in the list, while :73-80 and :107-120 are twins; tenants-rls:228 and :262; definer:64; prune:366; publisher:184.
- Direct writers not in the plan, all non-changing under complete grants:
  - `tenant-member-passkey-revoke:1142-1152` and `tenant-claim:1150` (probe-role cells on `createPool`, so the sink sees them).
  - `retire-dcr-cleanup:229`.
  - `audit-db-grants` (`ALTER ROLE … SET app.bypass_rls`, which stays).
  - `audit-outbox-rls`, `audit-chain-rls` and `audit-delivery-rls` set the bypass `off` or only comment on it.
  - `audit-outbox-unproxied-client` reads GUCs only.
- `collectNotices` / raw `notice` listeners: team-tenant-departure:769, :1753, :1985, :2022; team-key-rekey-writers:967; departed-member-operator-scripts:617. They run the migration blocks as `passwd_app` and assert on report NOTICEs. They pass today with a complete grant, so they stay; the `asApp` ones are wrapped by the table-list controls the plan already lists (:1052, :1961).
- Not in the plan, changes at the flip: `team-member-key-prune.integration.test.ts:557` (`enforced: false` → true) and its comment at :456-459 ("report mode … the flip turns the same check into a refusal"), plus the describe title "(report mode)" and header text of `rls-bypass-grants`. The latter two are prose for C12.
- Plan's list items that are correct: audit-anchor-publisher:240, share-departure:874, tenants-rls:244, definer:74. The `it.each` cells at rls-bypass-grants:139 and :150 call `rls_bypass_admits` directly and raise independent of any scan, so they are not plan-dependent.
- D6 for the converted refusal cells: each already asserts a positive notice, so each already proves an examined row. Where a converted cell keeps "must refuse", that property carries over (publisher:240 is an INSERT, so the new row is always examined). The vacuity risk is on the allow side and on T13's two cells.

# Mutation table: row-by-row

- **C1 twelfth column.** No CI test (T3).
- **C1 drop `metadata`.** The C4 walk cell does go red, because `readChain` selects `metadata` (audit-chain-verify-worker.ts:189-191). OK.
- **C2.** Role-state test pins `AUDITED_ROLES` through literal role names (audit-db-grants-role-state.test.mjs:260, :266-269). OK as long as the new role is added there. Only one C2 row exists for roughly eleven surfaces. No rows for initdb, compose, `set-role-password`, `helpers.ts`, env-allowlist.
- **C3.** Fallback-restored row: the existing env test passes with the DATABASE_URL fallback (verify-worker-env.test.mjs:80-82), so it must be split, with `NODE_ENV=production` in the failing case. The secret-key row is caught by `audit-anchor-wiring.test.ts:640` (`verifyWorkerViolations`). OK.
- **C4.** No mutation rows for the denial cells (grant an INSERT → denial red). Add.
- **C5.** Fails the whole suite at setup (not a named test). `[E-RLS-ENFORCED]` has no negative case (T7).
- **C6.** The mutation "a production grant drops a table a test reads" works only where a row is seeded (T13, D6).
- **C7.** ARM-ORDER swap is OK via the throwaway-table mutator. 4b accepts a row: needs a rewritten block (T7). D5 block: no row.
- **C8.** Only the definer row (T8). The script cells and `invalidateUserSessions` have none (T9).
- **C9.** Unit test row is OK.
- **C10.** Unit row is OK once T4 is settled. The `monitoring.tf` filter has no mutation row (delete the filter or change the `_logType`).
- **C11.** One direction only (T5).
- **C12.** No rows (prose).

# Recurring Issue Check

I did not get usable extracts of the R/RT rows, so each line below is judged from the digest's name for the pattern.

- R1: N/A (no shared helper reimplemented in the plan).
- R2: T11 (password literals duplicated across `helpers.ts`, `ci-integration.yml`, compose).
- R3: T11 (initdb filter gap); C2's member set is plan-derived from the publisher's footprint. No further gaps found.
- R4: N/A.
- R5: N/A.
- R6: N/A.
- R7: N/A.
- R8: N/A.
- R9: N/A.
- R10: N/A.
- R11: N/A.
- R12: N/A.
- R13: N/A.
- R14: C1 grant completeness is T3 (exact set check). The four verifier statements were probed per the plan. No further gap found.
- R15: N/A.
- R16: T11, T4, T7. Dev, CI and rls-smoke differences otherwise covered.
- R17: N/A.
- R18: T11 (password env, allowlist, README). OK otherwise.
- R19: T4 (pool-factory fakes), T2.
- R20: N/A.
- R21: N/A for this review.
- R22: N/A.
- R23: N/A.
- R24: N/A (flip migration is single-purpose).
- R25: N/A.
- R26 to R28: N/A.
- R29: N/A.
- R30: N/A.
- R31: T8 (`FORCE RLS` DDL on a shared dev database; stop workers).
- R32: T10.
- R33: T11 (CI filters).
- R34: N/A.
- R35: T10.
- R36: T2 (`.catch(() => undefined)`).
- R37: N/A.
- R38: N/A.
- R39: N/A.
- R40: N/A.
- R41: T6 (C11 declared evidence without backing).
- R42: C6 and C2 member sets recomputed above. T13 and the `:557` cell are the code minus plan.
- R43: N/A.
- R44: T5 (aggregator exit status through CI step).
- R45: N/A.
- R46: N/A.
- R47: T12.
- R48: N/A.
- R49: T6, and T14.
- R50: T4, T11, T7 (checks that may never have run).
- R51: N/A.
- R52: N/A.
- R53: N/A.
- R54: N/A.
- R55: N/A.
- R56: N/A.
- R57: N/A.
- RS1 to RS6: N/A (out of scope).
- RT1: N/A beyond T4's fake connection objects.
- RT2: C10 and C11 acceptance not testable as written (T4, T5). Other criteria OK.
- RT3: N/A.
- RT4: N/A.
- RT5: C4 passes through `createPool` and production `runTick`; the C8 script cells need the mock mechanism (T9).
- RT6: C9, C10 and C11 each have a unit test planned or recommended; the aggregator needs one (T5).
- RT7: T3, T5, T7, T8, T9, T12; the mutation table above.
- RT8: T2.
- RT9: T4.
- RT10: C4 and C6 pair allow with deny; C8 definer is only guard-paired (T8); script cells (T9).
- RT11: T1 (buffer residue when a refusal throws out of the helper) and T7 (negative test restoring a replaced function).

```json
[
{"id":"T1","severity":"Major","title":"expectBypassNotices does not splice when the statement throws; refusal cells cannot use it","file":"src/__tests__/db-integration/helpers.ts","line":901,"adjacent":false,"escalate":null},
{"id":"T2","severity":"Major","title":"Post-42501 transaction state: write-absent, allow twin and swallowed errors in C6 cells","file":"src/__tests__/db-integration/team-member-key-prune.integration.test.ts","line":520,"adjacent":false,"escalate":null},
{"id":"T3","severity":"Major","title":"C1 exact-privilege invariant and its mutation row have no CI test; committed manifest is not compared in CI","file":"src/__tests__/db-integration/audit-db-grants.integration.test.ts","line":115,"adjacent":false,"escalate":null},
{"id":"T4","severity":"Major","title":"C10 on-connect read trips the concurrent-query backstop; pool-factory fakes lack query","file":"src/__tests__/db-integration/setup.ts","line":178,"adjacent":false,"escalate":null},
{"id":"T5","severity":"Major","title":"C11 recorder mechanism, full-run detection, aggregation and both-direction gate proof are unspecified","file":null,"line":null,"adjacent":false,"escalate":null},
{"id":"T6","severity":"Major","title":"C11 evidence (grant set) overstates what E1 and the Risk section rely on; D6 per-table vacuity unaddressed","file":null,"line":null,"adjacent":false,"escalate":null},
{"id":"T7","severity":"Major","title":"C7: [E-RLS-ENFORCED] negative case conflicts with the function rule; 4b needs a sub-block per table; new codes lack mutation rows","file":"scripts/rls-cross-tenant-verify.sql","line":790,"adjacent":false,"escalate":null},
{"id":"T8","severity":"Major","title":"C8 audit definer cells: refusal pair is the explicit guard, not the body; mutation row over-claims","file":"prisma/migrations/20261021000000_definer_audit_functions_check_grant/migration.sql","line":22,"adjacent":false,"escalate":null},
{"id":"T9","severity":"Major","title":"C8 operator-script pair under a narrower grant has no mechanism; CLI tests use the superuser URL in CI; no mutation rows","file":"src/__tests__/db-integration/tenant-claim-cli.integration.test.ts","line":109,"adjacent":false,"escalate":null},
{"id":"T10","severity":"Major","title":"No real boot of the verify worker as the new role; boot smoke is env-only; manual-test artifact undefined","file":"scripts/checks/worker-bundle-smoke.json","line":null,"adjacent":false,"escalate":null},
{"id":"T11","severity":"Minor","title":"NOLOGIN/password/preflight and path-filter parity gaps for the new role","file":".github/workflows/ci-integration.yml","line":null,"adjacent":false,"escalate":null},
{"id":"T12","severity":"Minor","title":"C5 forbidden patterns: first duplicates an existing gate, second has no gate or mutation row","file":null,"line":null,"adjacent":false,"escalate":null},
{"id":"T13","severity":"Minor","title":"Prune cells at :366-379 are order-dependent; no mandatory-checks step in the plan","file":"src/__tests__/db-integration/team-member-key-prune.integration.test.ts","line":366,"adjacent":false,"escalate":null},
{"id":"T14","severity":"Minor","title":"[Adjacent] OR-arm order is not a PostgreSQL guarantee; verifier reads cross-tenant audit metadata under the sentinel grant","file":null,"line":null,"adjacent":true,"escalate":null}
]
```

---

# Expert outputs (verbatim), round 2

## Functionality expert

## Round 2 (incremental) — functionality review of the revised plan

I re-read the plan in full and checked the disposition claims against the code. Round-1 F1-F12 are all closed except where noted below. I found two new Major problems in C9/C5 and several Minor ones.

### Round-1 status
- **F1:** closed. C9's order follows the anchor-publisher precedent. The `rolcanlogin true` manifest row is in the C1 acceptance. The existing-RDS flow works end to end (`terraform apply` registers the new migrate task definition, then the migrate task runs). One gap remains in C9: see F13.
- **F2:** partly closed. The gate moved to the deploy. The preflight has a hole: F13.
- **F3, F4, F6, F7, F8, F10, F11:** closed. `PARALLEL SAFE` is now in C5 and in the C7 catalog check. C2 now carries the baselines, runbook and prose members. The removal of the on-connect read is acceptable; see F19.
- **F5:** closed in design. Remaining small gap: F18.
- **F9:** accepted as written. The database adjudicates trigger bodies when a test runs the firing statement. I agree.
- **F12:** closed.

### Answers to the specific checks
- **(a) C9 implementability.**
  - The migrate container runs `sh -c "set -e; npx prisma migrate deploy; node scripts/audit-db-grants.mjs"` (`ecs.tf:319-322`). A preflight before `migrate deploy` is implementable by editing that command.
  - `deploy.sh`'s `aws ecs run-task` (`:261-264`) has no `--overrides`. Forwarding an exported variable needs `--overrides containerOverrides[].environment`. That is feasible but is new surface that `deploy-rollback.test.mjs` may stub.
  - `_prisma_migrations` can be read with `MIGRATION_DATABASE_URL`, which the task already holds. Use `to_regclass` for the fresh state.
  - Treat `finished_at IS NULL` and `rolled_back_at IS NOT NULL` rows as "not applied". Prisma would itself refuse a failed row (P3009).
  - The preflight needs a Dockerfile `COPY` and a `RUNTIME_SCRIPTS` entry in `check-runtime-image-assets.mjs`; see F15.
- **(b) D6.**
  - `audit-db-grants.mjs:293-304` reads `pg_db_role_setting` for every role (`setrole = 0`) and for each `AUDITED_ROLES` entry, for this database or all databases.
  - `DENIED_SETTING_RE` (`:380`) refuses any `client_min_messages=` value live and in the manifest.
  - The migrate task runs it on every forward deploy; `--rollback-to` skips it.
  - Gap: a cluster-level default (RDS parameter group) is not in `pg_db_role_setting`; see F19.
- **(c) C5 audit mode check.**
  - Callers: the migrate task, `audit-db-grants.integration.test.ts`, `retire-dcr-cleanup-worker.integration.test.ts`, `ci-integration.yml`. All run against migrated and flipped databases.
  - An unmigrated database has no function. The plan must say absent function means fail loudly.
  - Un-flip recovery: F14.
- **(d) C8 `options=-c role=…`.**
  - `checkedConfig` only matches `client_min_messages` (`pool-factory.ts:105`), so `-c role=` passes. `tenant-domain.ts:252-257` and the two migrate scripts hand the connection string to `createPool` and parse nothing.
  - A superuser login can `SET ROLE` a NOLOGIN role. RLS then applies by `current_user`.
  - The harness `Client.prototype.query` wrapper exists (`setup.ts:177`), so the C11 producer can see `setBypassGucs`.
- **(e) C1 connection limit.** The RDS master (CREATEROLE) can `CREATE ROLE`/`ALTER ROLE … CONNECTION LIMIT` for a role it created or administers. `convergeRole` does not reset it: `ROLE_ATTRS` (`bootstrap-rds-roles.mjs:108`) has no limit clause. But it also never sets it; see F16.
- **(f) D1 stop rule.** Not decidable as written; see F17.

### Findings

**F13 — Major — design (R49) — The C9 preflight passes for an environment that skips the report-mode release**
- Problem: The refusal condition is "report-mode migration recorded applied, flip not, attestation absent". A database that has `_prisma_migrations` but has not yet applied `20261019000000_rls_bypass_admits_report_mode` passes silently. That is an environment upgrading from before report mode, and it applies report mode and the flip in one run. It never had an observation window, which is E1's first gate. "Fresh database passes" is only safe for an absent or empty migration table.
- Fix:
  - Fresh means the migration table is absent or empty. Any other database with the flip pending requires the attestation.
  - Pin the allow case: a fresh database still passes with no attestation, and an attested deploy passes.
  - Give the migration names as constants with a gate (mutation: a renamed migration must turn a test red).

**F14 — Major — design (RT10, R49) — C5's audit check blocks the fix deploy after an un-flip, and the "allow flag" has no delivery path**
- Problem: The plan says the un-flip is the recovery, and that audit-db-grants fails when the mode is false "unless run with an explicit allow flag". A fix release deployed after an un-flip runs migrate, then the audit, which fails. `deploy.sh` aborts before any `update-service` (`deploy.sh:262-282`), so the fix cannot ship.
  - The migrate task command is fixed in `ecs.tf` and `deploy.sh` has no override today. An allow flag has no path in unless the same forwarding mechanism as C9's attestation carries it.
- Impact: The recovery path (lift the refusal, ship the fix) is blocked by the control meant to make it visible.
- Fix:
  - Specify an allow variable forwarded like the attestation.
  - State that setting it records the state in the task log.
  - Add a test for both arms: audit fails on false, passes with the variable.
  - Alternatively, make the un-flip a migration too, so the deploy ordering handles it.

**F15 — Minor — design — C9's surface list omits the runtime-image plumbing**
- Evidence: `Dockerfile:371-392` copies the audit script and its data files by hand. `check-runtime-image-assets.mjs:66` has `RUNTIME_SCRIPTS = ["scripts/audit-db-grants.mjs", "scripts/bootstrap-rds-roles.mjs"]`.
- Fix: Add the preflight script to the Dockerfile and `RUNTIME_SCRIPTS`. Say that the `ecs.tf` command and `deploy.sh` run-task `--overrides` change (and the deploy tests) are in scope.

**F16 — Minor — design — C1 CONNECTION LIMIT is not reliably applied or checked, and 10 is not tied to the pool cap or task count**
- Problem 1: On a fresh RDS the bootstrap creates the role first with no limit. The migration then skips "create when absent". C1's convergence list does not include the limit.
- Problem 2: `audit-db-grants.mjs:288` reads `rolcreatedb … rolcanlogin` and no `rolconnlimit`, so drift is undetected.
- Problem 3: `createPool({ connectionString })` in the worker (`audit-chain-verify-worker.ts:592`) sets no `max`, so pg defaults to 10 per task. The verify service uses `worker_desired_count` (default 1; any N above 1 overshoots), and rolling deploys overlap tasks.
- Fix:
  - Make convergence `ALTER ROLE … CONNECTION LIMIT 10`.
  - Add `rolconnlimit` to the audit and manifest.
  - Name the pool cap (for example 2) and state the arithmetic `desired_count × cap + headroom ≤ limit`.

**F17 — Minor — design — The D1 stop rule is not decidable as written**
- Problem:
  - "Requires adding a table to a production grant" has no measure. A natural one is a diff of `BYPASS_GRANT` table sets in `tenant-rls-grants.ts` against main, taken after the first full enforced run.
  - It does not say when the check is done (it needs the flip in place, so it is the first step of Phase 2).
  - It does not say what remains if it fires. C6, C7 and C5's `setup.ts` refusal depend on the shipped flip. D1's alternative (a post-migrate statement on CI databases) is the only fallback and is not specified.
- Fix: State the measure, the moment, and the fallback shape.

**F18 — Minor — design — C11 consumer mapping details**
- Evidence: a quick derivation over `BYPASS_GRANT` finds eight pairs of members with the same purpose and the same set of models (for example `AUTH_DELETE_USER` and `AUTH_SESSION_LIFECYCLE`, `TENANT_SESSION_CACHE_INVALIDATION` and `USER_SESSION_CACHE_INVALIDATION`), once table order is ignored.
- Problem: Evidence for one member counts for its twin. A probe-role connection set with `SET LOCAL ROLE` records its login user (C8's `options` path is recorded; the `SET LOCAL ROLE` path is not).
- Fix: Normalise table order, and state that twins share evidence; or require evidence per name by recording the call site.

**F19 — Minor — prose — D6 should state its residual**
- A cluster-level `client_min_messages` default (RDS parameter group, `postgresql.conf`) is not visible in `pg_db_role_setting`. Add a sentence to D6's residual.

### Not found / checked
- C8's `-c role=` startup option and the CLI path: no rejection or surprise.
- C9's order for existing RDS: executable, apart from F13 and F14.
- The attestation walkthrough (variable → `deploy.sh` overrides → preflight → exit code → `deploy.sh` migration-failed path) is complete and satisfiable, apart from F15's plumbing.

## Recurring Issue Check
- R1: Checked — no issue.
- R2: Checked — no issue.
- R3: Checked — C2 and C10 member sets re-derived.
- R4: N/A — no event dispatch.
- R5: N/A — no new multi-step DB writes.
- R6: N/A — no deletes.
- R7: N/A — no E2E selectors.
- R8: N/A — no UI.
- R9: N/A.
- R10: N/A.
- R11: N/A.
- R12: N/A — no audit actions.
- R13: N/A.
- R14: Finding F16 (connection limit grant completeness).
- R15: Checked — `current_database()` used.
- R16: Checked — dev/CI LOGIN handling is in E5.
- R17: N/A.
- R18: Finding F15 (runtime asset list).
- R19: N/A.
- R20: N/A.
- R21: N/A.
- R22: N/A.
- R23: N/A.
- R24: Checked — role migration and flip are separate and ordered.
- R25: Checked — C11 persistence and consumers.
- R26: N/A.
- R27: N/A.
- R28: N/A.
- R29: Checked — derived claims in D6, C8, C9 re-derived; F18 evidence derived.
- R30: N/A.
- R31: N/A.
- R32: Checked — boot cell present (C4).
- R33: Checked — rls-smoke, e2e and ci-integration reviewed.
- R34: Checked — no deferral without a cost statement.
- R35: Checked — manual-test artifact covers C9, un-flip and audit.
- R36: N/A.
- R37: N/A.
- R38: N/A.
- R39: N/A.
- R40: N/A.
- R41: Checked — D6 relies on the audit; confirmed live with F19 residual.
- R42: Checked — F18.
- R43: N/A.
- R44: N/A.
- R45: N/A.
- R46: N/A.
- R47: N/A.
- R48: N/A.
- R49: Findings F13 and F14.
- R50: Checked — no new finding.
- R51: N/A.
- R52: Checked — C5's audit widens a control; F14 is its latent defect.
- R53: N/A.
- R54: Checked — no ambient suspension added.
- R55: N/A.
- R56: N/A.
- R57: N/A.
- RS1-RS6: N/A — out of scope.
- RT1-RT11: out of scope. RT10 is cited in F14 because the blocked path is a recovery path.

```json
[
  {"id":"F13","severity":"Major","title":"C9 preflight passes for an environment that skips the report-mode release (no observation window)","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null},
  {"id":"F14","severity":"Major","title":"C5 audit check blocks the fix deploy after an un-flip; the allow flag has no delivery path in the migrate task","file":"infra/terraform/ecs.tf","line":319,"adjacent":false,"escalate":null},
  {"id":"F15","severity":"Minor","title":"C9 omits Dockerfile COPY, RUNTIME_SCRIPTS entry, ecs.tf command and deploy.sh run-task overrides","file":"Dockerfile","line":378,"adjacent":false,"escalate":null},
  {"id":"F16","severity":"Minor","title":"CONNECTION LIMIT not applied on bootstrap-first path, not audited, and 10 not tied to pool cap or task count","file":"scripts/bootstrap-rds-roles.mjs","line":108,"adjacent":false,"escalate":null},
  {"id":"F17","severity":"Minor","title":"D1 stop rule has no measure, moment, or fallback shape","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":null,"adjacent":false,"escalate":null},
  {"id":"F18","severity":"Minor","title":"C11 grant mapping: twin BYPASS_GRANT entries share evidence; SET LOCAL ROLE connections record the login user","file":"src/lib/tenant-rls-grants.ts","line":128,"adjacent":false,"escalate":null},
  {"id":"F19","severity":"Minor","title":"D6 residual omits cluster-level client_min_messages (parameter group)","file":"scripts/audit-db-grants.mjs","line":293,"adjacent":false,"escalate":null}
]
```

## Security expert

## Security review, Round 2 (incremental): verify-worker-readonly-role-rls-enforce-plan

No Critical findings. Seven findings: six Minor design findings (S9-S14) and S4 continuing at reduced severity (Minor, prose). Round-1 S1, S2, S3, S5, S6, S7 and S8 are closed as the plan resolves them. Read-only; nothing was run against a database.

## Round-1 fixes verified

- **S1 (role convergence)**
  - **Taken:** C1 converges an existing role: it revokes table, sequence and routine privileges in `public`, revokes schema and default privileges, and asserts attributes and zero memberships. Table-level `REVOKE ALL` also drops that grantor's column grants.
  - **Not fully taken:** gaps in the convergence are in S9.
- **S2 (merge equals flip)**
  - **Taken:** `.github/workflows` contains no `deploy.sh` or `run-task`, so "merging does not deploy" holds. The migrate task (`ecs.tf:321`, `set -e; npx prisma migrate deploy; node scripts/audit-db-grants.mjs`) is the single choke point, and D1's stop rule is sound.
  - **Residual, acceptable and stated:** compose `migrate` runs only `prisma migrate deploy` (docker-compose.yml:154), so self-hosted installs flip with no attestation and no audit.
- **S3 (un-flip detection):** the mode audit on every AWS deploy is adequate. I accept that the committed un-flip migration and the heartbeat line were not taken. The residual is that detection waits for the next deploy and never runs on compose. That needs one sentence in `deployment.md`.
- **S5 (timeouts):** the recorded reason is technically true. `statement_timeout`, `idle_session_timeout`, `idle_in_transaction_session_timeout` and `lock_timeout` are all user-settable, so a role-level default does not bind the credential holder. `CONNECTION LIMIT` is enforced by the server. I accept the residual. Role-level timeouts would still bound a worker bug, but that is not the threat here.
- **S6, S7:** fixed. The C1 tenant-scope statement, the C5 not-covered list, and C7's sentinel D5 block plus structural arm check cover them.
- **S8:** moot for the self-clearing signal. See S12 for what removing the on-connect check leaves open.

## Findings

### S4 (continuing) [Minor, prose] The Accepted reason is partly inaccurate; the residual is acceptable for rotate-key only

- **Problem:**
  - The plan says the fix needs "web, CLI and extension read together". The only client of `/api/vault/rotate-key` is `src/components/vault/rotate-key-dialog.tsx`. A grep of `cli/`, `extension/` and `ios/` finds no caller.
  - The dialog already reads `effects.invalidationFailed` from the 200 response (lines 74-76) and shows a persistent warning toast. So the rotating user is told, and C10's error log adds the operator signal.
  - rotate-key is therefore acceptable as logged.
- **What remains:** SCIM `Users/[id]` (three sites) and team-member removal. The actors there are an IdP or an admin, who get no failure signal. A SCIM deprovision that returns 2xx with live tokens is not retried by the IdP.
- **Evidence:**
  - Those sites have a comment saying "(fail-open)".
  - `SESSION_INVALIDATE_FAILED` already exists as a post-commit 500 in `change-passphrase/route.ts:146` and `recovery-key/recover/route.ts:250`.
- **Fix:**
  - Correct the stated reason in the Anti-Deferral entry.
  - Have the SC6 issue filed before the attestation is signed, not "with the PR".
  - Keep C8's ten-model cell as the compensating control.
- **What would change my mind (to drop it):** the corrected reason plus the issue being linked from the E1 checklist.

### S9 [Minor, design] C1 convergence block misses privilege paths and does not assert privileges itself (R14, R15)

- **Problem:** the migration's closing assertion covers attributes and memberships only. The exact-privilege check is a CI integration cell on a fresh database. A surviving over-grant on an existing production role is caught only by the migrate task's audit, after the flip has applied (the flip migration follows C1 in the same `migrate deploy`). Specific gaps:
  1. `REVOKE` removes only grants made by the revoking role. A grant by another grantor survives when the migration role is not a superuser (RDS).
  2. Ownership of objects is not checked: tables, functions, schemas, or the database owned by the role carry implicit full privileges.
  3. Role settings (`rolconfig`) are not cleared. A stale `ALTER ROLE ... SET search_path` or `app.*` survives. The audit's item 10 reports it, but convergence does not clear it.
  4. Grants in schemas other than `public` and on other databases (CONNECT, TEMP) are not touched.
  5. Default privileges are per-grantor.
  6. `CONNECTION LIMIT 10` is stated under "creates when absent". It must also be applied by `ALTER` to an existing role.
  7. "Raising unless member of no role" makes a wedged migrate task, not convergence. That is loud, so acceptable, but say so.
  8. `REVOKE ALL` cannot touch PUBLIC-inherited access. The plan says that for functions; the same holds for `CREATE` and `TEMP` on the database.
- **Fix:**
  - Add an in-migration loop over `aclexplode` on `pg_class`, `pg_attribute`, `pg_proc` and `pg_namespace`, plus `pg_shdepend` ownership, that raises on anything outside D2. Do this before the flip applies.
  - `ALTER ROLE ... RESET ALL`.
  - `ALTER ROLE ... CONNECTION LIMIT 10` on the existing-role path.
  - **Pair with an allow case:** the fresh role ends with exactly the eleven columns and still passes.
  - **Red-prove:** one seeded over-grant per clause: another grantor, ownership, `rolconfig`, a non-`public` schema.

### S10 [Minor, design] The mode-audit allow flag must not become a default (C5)

- **Problem:**
  - The migrate task command is hard-coded in `ecs.tf:321`. After an un-flip, the natural fix to get deploys passing is to add the flag there or in an env var, and it stays.
  - The flag also changes `--write`, which regenerates the manifest.
- **Fix:**
  - The flag is an argv option only, with no environment variable.
  - `deploy.sh` does not forward it.
  - The audit prints a WARNING line on every use.
  - `audit-anchor-wiring.test.ts` (HCL-parsing) asserts the migrate command string carries no allow flag.
  - `--write` refuses to run with it.
- **Pair the allow case:** a deliberate un-flip with the flag passes, without it fails. **Red-prove:** the wiring assertion with the flag added to the command string.

### S11 [Minor, design] C9 attestation binding and the "recorded as applied" test (R50, R49)

- **Preflight privileges:** it reads `_prisma_migrations` through the existing `MIGRATION_DATABASE_URL`, which the migrate task already holds. It needs no new privilege and widens nothing.
- **Accidental or permanent satisfaction:**
  - A variable exported in a shell profile or CI environment, or set in the Terraform task environment, satisfies it.
  - After the flip applies, the preflight no longer fires, so a stale attestation is harmless for this flip.
  - A generic variable name would still pre-satisfy a future flip.
  - "Absent" is also weaker than "attested this exact change".
- **Problem:** a failed or rolled-back `_prisma_migrations` row might count as "applied".
- **Fix:**
  - The variable's value must equal the flip migration's directory name, for example `RLS_FLIP_ATTESTED=<migration name>`, and anything else is refused.
  - "Applied" means `finished_at IS NOT NULL AND rolled_back_at IS NULL`.
  - A wiring test asserts neither the Terraform task environment nor `deploy.sh` defaults it.
- **Allow case:** the correct value passes. A fresh database passes. **Red-prove:** a wrong value, a failed-row case.

### S12 [Minor, design] D6: the deploy-time audit does not see a server-level `client_min_messages` (R50)

- **Problem:** the audit's item 10 reads `pg_db_role_setting` (`audit-db-grants.mjs:293-305`). On RDS a parameter group sets `client_min_messages` at server level, which that table does not show. The removed on-connect read would have caught it. A silent channel at the flip is covered by the positive canary, but a later parameter-group change is covered by neither. Refusal itself does not depend on the report, so the effect is lost visibility of swallowed refusals. Together with SC7 being deferred, the only remaining signal is C10's error-level log with `code` 42501.
- **Evidence:** only `pg_db_role_setting` is queried. The audit also never runs on the compose path.
- **Fix:** add `SELECT setting, source FROM pg_settings WHERE name = 'client_min_messages'` to the audit, run by a role without role-level defaults, and fail when the effective value is above `warning`. That is a one-query cost, no new moving part. Answering your question (f): the deploy-time audit is adequate for a refusal that is self-enforcing, with this addition and the stated "between deploys" residual.
- **Allow case:** `warning` or lower passes. **Red-prove:** a `postgresql.conf`-level setting in the integration cell.

### S13 [Minor, design] C8 probe role lifecycle in the shared cluster (R16, RT11)

- **Problem:** the probe role is NOLOGIN but holds owner-like privileges, including UPDATE and DELETE on `audit_logs`. Those are exactly what the C13 revoke denies `passwd_app`. Roles are cluster-global (E5) and shared with the dev database. A crash between `CREATE` and the `finally` leaves it behind.
  1. `DROP ROLE` fails while the role holds privileges; it needs `DROP OWNED BY` first, and `finally` must do that.
  2. A fixed name collides across parallel test files, and one file's `finally` drops the role another is using.
  3. If the probe were `GRANT`ed to `passwd_app` or another login role for `SET ROLE`, a leftover would be a standing escalation of the app role.
- **`options=-c role=…`:** `checkedConfig` in `pool-factory.ts` rejects only `client_min_messages`, so `role` is accepted. Production code reaches it only if a production URL carries it, which is an operator action. The test-only reach is bounded by `setup.ts`'s same-host/port/database check. The superuser session can still `RESET ROLE`, so `assertRlsApplies` (keyed on `current_user`) must stay.
- **Fix:**
  - Unique per-file name.
  - `SET ROLE` only through the superuser connection, never by membership.
  - `DROP OWNED BY ... ; DROP ROLE` in `finally`.
  - A stale-probe sweep at suite start.
  - State that no membership is ever granted.
  - C11's recorder takes the role from the URL option, so it must never log the URL itself, which carries the password.
- **Allow case:** the cell still passes after a sweep.

### S14 [Minor, design] [Adjacent] CONNECTION LIMIT 10 against a rolling deploy

- **Problem:** this may overlap with the functionality expert's scope. The verify service has no explicit `deployment_maximum_percent` (only the publisher service sets one, at `ecs.tf:714`), so ECS's default 200% lets old and new tasks overlap. Two pools plus any Prisma default pool can exceed 10 and fail with 53300 on the rollover tick.
- **Fix:** C3's "pool capped below the limit" must say the cap is at most half the limit (so at most 5), or pin `deployment_maximum_percent = 100` as the publisher does.

## Answers to the specific checks

- **(a)** C9 can be satisfied accidentally or permanently only until the flip applies. See S11. The preflight needs no new database privilege.
- **(b)** See S13. A role created by tests in a shared cluster needs unique naming, `DROP OWNED` cleanup, and a stale-role sweep. Production reach through the `options` URL needs an operator to put it there.
- **(c)** See S10.
- **(d)** See S9.
- **(e)** C11's recorder is test-only and free of bind parameters as specified. It lives under `src/__tests__/db-integration`, issues no query, and records purpose, table list and role. Purpose and table list are bind values of the `setBypassGucs` statement but are constants, not secrets. `tenantId` is not recorded. Keep it from serialising the connection string on its parse-error path.
- **(f)** See S12.

## Recurring Issue Check

- R1 Checked, no issue.
- R2 Checked, no issue.
- R3 Checked. S4's remaining sites are recorded in SC6.
- R4 N/A.
- R5 Checked. C1 and the flip are separate migrations, applied in order within one `migrate deploy`.
- R6 N/A.
- R7 N/A.
- R8 N/A.
- R9 N/A.
- R10 Checked, no issue.
- R11 N/A.
- R12 N/A.
- R13 N/A.
- R14 Finding S9. The D2 column set remains minimal and sufficient.
- R15 Finding S9.
- R16 Finding S13. Dev and CI parity is handled by the C2 surfaces.
- R17 Checked, no issue.
- R18 Checked. C2's member set is extended and sound.
- R19 N/A.
- R20 N/A.
- R21 N/A.
- R22 N/A.
- R23 N/A.
- R24 Checked. The flip is a single-statement migration.
- R25 N/A.
- R26 N/A.
- R27 N/A.
- R28 N/A.
- R29 Checked. Re-derived: `deploy.sh` is not called from `.github/workflows`; no CLI, extension or iOS caller of rotate-key; `rotate-key-dialog.tsx:74` handles `invalidationFailed`; compose `migrate` does not run the audit; `audit-db-grants.mjs` item 10 reads `pg_db_role_setting` only.
- R30 N/A.
- R31 N/A.
- R32 Checked. C4 has a boot cell with a ready signal.
- R33 Checked. See S10 for the wiring assertion.
- R34 N/A.
- R35 Checked. C12 includes a manual-test artifact.
- R36 Checked. S10 is the markerless-weakening risk of the allow flag.
- R37 N/A.
- R38 Checked. The un-flip now has an audit-visible exit (the allow flag). See S10.
- R39 N/A.
- R40 N/A.
- R41 N/A.
- R42 Checked. C10 now derives the member set by class.
- R43 Checked, no widening: the new role is narrower than `passwd_app`.
- R44 Checked. The audit's exit status is the gate in the migrate task, where `set -e` applies.
- R45 N/A.
- R46 N/A.
- R47 Checked.
- R48 Checked. One verdict site for the mode.
- R49 Checked. C9's class ("checks that the operator attested") is honest. See S11 for the binding.
- R50 Findings S11 and S12.
- R51 N/A.
- R52 Checked. See S9.
- R53 N/A.
- R54 Checked. The bypass grant is transaction-local.
- R55 Checked, no issue.
- R56 N/A.
- R57 N/A.
- RS1 N/A.
- RS2 N/A.
- RS3 N/A.
- RS4 Checked, no issue. Keep the recorder from logging the connection URL (S13).
- RS5 N/A.
- RS6 N/A.

```json
[
  {"id":"S4","severity":"Minor","title":"Accepted reason partly inaccurate (rotate-key has one web client that already shows invalidationFailed); SCIM and team removal remain, SC6 must be filed before attestation","file":"src/components/vault/rotate-key-dialog.tsx","line":74,"adjacent":false,"escalate":null},
  {"id":"S9","severity":"Minor","title":"C1 convergence misses other-grantor grants, ownership, rolconfig, other schemas/databases, ALTER of CONNECTION LIMIT, and has no in-migration privilege assertion","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":47,"adjacent":false,"escalate":null},
  {"id":"S10","severity":"Minor","title":"Mode-audit allow flag must be argv-only, not forwarded, warned on, and pinned out of the migrate command","file":"infra/terraform/ecs.tf","line":321,"adjacent":false,"escalate":null},
  {"id":"S11","severity":"Minor","title":"C9 attestation should be bound to the flip migration name and require finished_at set and rolled_back_at null","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":131,"adjacent":false,"escalate":null},
  {"id":"S12","severity":"Minor","title":"Deploy-time audit misses a server-level client_min_messages (parameter group); add a pg_settings check","file":"scripts/audit-db-grants.mjs","line":293,"adjacent":false,"escalate":null},
  {"id":"S13","severity":"Minor","title":"C8 probe role: unique name, DROP OWNED cleanup, stale sweep, no membership grants","file":"docs/archive/review/verify-worker-readonly-role-rls-enforce-plan.md","line":118,"adjacent":false,"escalate":null},
  {"id":"S14","severity":"Minor","title":"CONNECTION LIMIT 10 vs overlapping verify tasks on rolling deploy; cap the pool at half or pin deployment_maximum_percent","file":"infra/terraform/ecs.tf","line":734,"adjacent":true,"escalate":null}
]
```

## Testing expert

# Round 2 testing review of the revised plan (incremental, read-only)

Rule extraction: I did not re-extract common-rules.md this round. The Recurring Issue Check below is judged from the Round 1 digest names.

T1, T3, T4, T6, T8, T11, T12, T13 and T14 are fixed or moot as the dispositions say. I re-checked T1 and T3 against the code and found no new gap in them. The remaining Round 1 items continue below with their old ids (T2, T5, T7, T9, T10). The new findings are T15 to T21.

## What I verified as correct

- **T1 / `expectBypassRefusal`.** It is implementable as specified.
  - A server NOTICE is emitted before the ErrorResponse on the same socket, so the report is in the sink buffer before the rejection surfaces.
  - The Prisma-wrapped and raw-pg error shapes both carry 42501 and the message text; `pgErrorCode` already handles the Prisma wrapper.
  - The definer cells raise `RLS_BYPASS_NOT_GRANTED: audit_logs` from the guard's own call to `rls_bypass_admits`, so the "message names the table" rule holds there too.
- **T3 / exact-privilege cell.** The privilege functions can be enumerated without a hard-coded list that drifts.
  - The PUBLIC-derived part is computable from `has_function_privilege('public', …)`; `audit-db-grants.integration.test.ts:413` already uses that form. `has_table_privilege` and `has_column_privilege` return true only for what the role or PUBLIC holds.
  - The D2 columns are the one deliberate literal.
  - Cover all four object kinds, and check the schema's CREATE privilege too.
- **T4 moot.** D6's claim holds: `audit-db-grants.mjs:380` denies `client_min_messages`, `app.*`, `log_min_messages` and `row_security` as role or database settings.
- **T10 / boot cell, readiness signal.** `erroredTenantCount` is a real heartbeat field. The existing env test already shows how to spawn `tsx` with a clean environment.
- **C11 producer.**
  - The statement is visible to the wrapper. `setBypassGucs` is `$executeRaw` with three bound values: purpose, tenant id, tables (tenant-rls-grants.ts:261-264). Prisma's pg adapter sends `client.query({text, values})`, so the wrapper can read `config.values`.
  - A raw-pg caller that sends the text with literals would not parse the same way, but no `BYPASS_GRANT` member is set that way.
  - Appending a short line with `O_APPEND` from sequential forks (`maxWorkers 1`, `isolate`) does not race.

## Findings

### T9. Running the existing CLI suites a second time under `role=probe` breaks their own assertions (Major, design, needs-execution) — continues T9
- **Problem.**
  - `tenant-claim-cli.integration.test.ts:91-93` defines `currentDbUser()` as `current_user` on `ctx.su`, and :972, :995, :1018 and :1050 assert `event.dbUser` equals it.
  - The `tenant_claim_events` INSERT trigger records `current_user` and `session_user` (migration 20260731100000, lines 112-113). Under `-c role=probe` the CLI's `current_user` is the probe and `session_user` is the superuser, so these assertions fail on the second run.
  - Each file stubs `MIGRATION_DATABASE_URL` only when it is unset (cli:105-111, cli-binding:168-169). In CI it is set to the superuser, so the second run needs an unconditional per-run stub.
  - Roughly 7,000 lines of cells (tenant-claim-cli, cli-binding, events, backfill) run twice. Parametrising them is not "the existing suites unchanged": it needs a `describe.each` over the two URLs and a `dbUser` expectation derived from the connection under test.
- **Impact.** The plan's C8 cell cannot be added as written; or someone special-cases the assertions and weakens the first run.
- **Action.**
  - Name which suites run twice.
  - Make the `dbUser` assertions read the effective role of the run.
  - Budget the CI time, since `integration` has a 30-minute cap.
  - Before building, run one suite under `options=-c role=…` to list every remaining owner-only operation. Owner-only operations such as `session_replication_role` or DDL cannot be granted to the probe and would be false failures.

### T20. "The table owner's privileges on `public`" is not a defined grant set (Major, design, needs-execution)
- **Problem.**
  - The probe is the effective role (`current_user`), so EXECUTE is checked against it, not against the superuser. Every RLS policy calls `rls_bypass_admits` and `rls_bypass_enforced`, and those have PUBLIC revoked.
  - The CLI and scripts also call the PUBLIC-revoked routines (`tenant_claim_events_purge_for_tenant`, `audit_log_*`, `team_member_key_prune`).
  - Sequences need USAGE (the `seq` column), the schema needs USAGE, and the privileges the owner holds on `audit_logs` (UPDATE and DELETE are revoked from `passwd_app` but held by the owner) must be reproduced, because an owner-shaped role has them on RDS.
  - The plan lists none of these and says "tables".
- **Impact.** A probe short of EXECUTE on `rls_bypass_*` fails every cell with "permission denied for function", which is the setup.ts message and is easy to misread. One that grants too much (for example `app-role-denied-privileges` targets) tests a different shape than RDS.
- **Action.**
  - Define the set: ALL on tables and sequences, EXECUTE on routines, USAGE on the schema.
  - Derive it from the owner's actual ACL (`pg_class.relacl` / `aclexplode`) or from `has_*_privilege(owner, …)` rather than from a hand list.
  - Assert, as a precondition cell, that `has_*_privilege(probe, …)` equals the owner's for every object, so the probe is provably owner-shaped.

### T17. Probe-role lifecycle: collisions, dependency on DROP, and crash residue (Major, design) — RT11
- **Problem.**
  - Roles are cluster-global (E5) and two worktree databases on one cluster can run integration at once. The plan names no role-name scheme, so a fixed name collides across databases and across a crashed earlier run (CREATE fails with 42710).
  - A role holding ALL on every table cannot be dropped by `DROP ROLE` alone; it needs `DROP OWNED BY` first. "Dropped in `finally`" does not say so.
  - A SIGKILL or vitest timeout skips `finally`, and `afterAll` does not run, so a NOLOGIN role with a table-wide grant and ACL entries on every `public` table is left behind.
  - That residue also changes what `audit-db-grants.integration`, `app-role-denied-privileges` and `revoke-public-connect` see on the next run.
  - `tenant-claim.integration.test.ts:1099-1160` already solves this for a login probe with a random name and `VALID UNTIL`, which does not apply to NOLOGIN.
- **Action.**
  - Random per-run name.
  - An idempotent pre-clean in `beforeAll` (`DROP OWNED BY` plus `DROP ROLE IF EXISTS` for the file's prefix), or a sweep in `setup.ts` for the prefix.
  - Order the cleanup as `DROP OWNED BY` then `DROP ROLE`.
  - Add a cell for "leftover role from a crashed run does not break the next run".

### T5. The consumer cannot read attributes of a probe role that was dropped (Major, design) — continues T5
- **Problem.**
  - C11's consumer "reads the role attributes from the database" after the suite. The probe, whose evidence is the point of C8's second CLI run, is gone by then, because each file drops it.
  - The producer records the `role` option's name only, so `pg_roles` has no row and the consumer must treat unknown as something.
    - If unknown counts as "subject to RLS", a role that does not exist gives evidence.
    - If it counts as "not subject", the TENANT_* grants stay on the list and the second CLI run buys nothing.
  - A related gap: the plan does not say who creates the evidence file or who truncates it. A per-file `setup.ts` that truncates erases the earlier files, because `setupFiles` runs once per test file. It must only append, and the CI step must start from a fresh path.
- **Action.**
  - Have the test that creates the probe write an attribute line to the evidence file (name, `rolsuper`, `rolbypassrls`).
  - Have the consumer fail on any role it cannot resolve.
  - State that `setup.ts` only appends.

### T7. The D5 block's rows cannot be shown to fail on their own (Major, design) — continues T7; RT7
- **Problem.**
  - The D5 block runs only after Block 1 passes, and Block 1 now contains `[E-RLS-ARM-ORDER]`. Under `ON_ERROR_STOP` any policy that would make the D5 block refuse differently is already stopped by the earlier check.
  - The D5 block adds something only if the arm order is textually right but evaluated differently, which no negative case can construct.
  - The mutation row "the D5 block's sentinel case removed → negative-test case" therefore has no red test that fails for the D5 block's reason.
  - Separately, the sentinel half can discriminate only in a table holding a sentinel row (`tenants` and similar), because refusal fires on any examined row when the bypass arm runs first. The seed file seeds A0 and B0, so the sentinel case is vacuous per table elsewhere.
- **Action.** State the D5 block as an observation pin, name its red test honestly (a unit-style fixture running the block against a psql stub that lets the withheld statement succeed, if the repo has that pattern), or drop the row. Restrict the sentinel cell to tables that hold sentinel rows, or seed one.

### T15. Two mutation rows name a test that cannot fail for the stated reason (Major, design) — RT7
- **C2 row "remove the manifest's `rolcanlogin` row → `audit-db-grants` integration".** The integration test uses a manifest generated from the same database (audit-db-grants.integration.test.ts:115-135, deliberately not the committed one). It cannot go red from an edit to the committed JSON.
  - The committed manifest is read by `scripts/__tests__/audit-db-grants-role-state.test.mjs:29`, and only the anchor publisher's `rolcanlogin` literal is pinned there (:260).
  - Add the verifier's literal to that test, and re-point the row at it.
  - Likewise nothing in CI compares the committed manifest's eleven column rows with D2; C1's "manifest carries the same rows" is manual unless that test pins them.
- **C5 row "function returns `false` → `[E-RLS-ENFORCED]` negative case".** The negative case replaces the function itself and expects the check to fail, so it is not what a mutated flip migration reddens. The mutation reddens `setup.ts` and the rls-smoke verify itself. Name those.
- **Rows still missing:** C4 boot cell; C6's `setup.ts` same-database refusal (F6); C7's 4b no-exception arm is present, but C9's `deploy.sh` forwarding and the migrate-task command ordering have none; C3's `NODE_ENV` split is present.
- **Action.** Re-point the two rows and add the missing ones.

### T16. The C5 audit-mode integration cell needs to un-flip a shared database (Major, design) — R31, RT11
- **Problem.**
  - The mutation row "audit-db-grants stops checking the mode → its integration cell" needs the audit script, a separate process, to see `rls_bypass_enforced()` returning false.
  - That means a committed `CREATE OR REPLACE` on the shared dev database, then a restore. That hits every other session meanwhile, including a running dev server, and the function rule forbids creating that routine outside migrations and the one C7 negative case.
  - A rolled-back transaction cannot work, since the audit connects on its own connection.
- **Action.** Make the mode check a pure function in `audit-db-grants.mjs` (the file already exports `roleStateViolations` and friends) and unit-test it from a stubbed row. Keep an integration cell only for "enforced database → OK".

### T10. Boot cell on a shared database is environment-sensitive (Major, design, needs-execution) — continues T10
- **Problem.**
  - The first tick enumerates every tenant in the database and walks every chain. On a dev database that holds leftover fixtures, or the real sentinel chain that `audit-chain-verify-worker-rls` already says it only assumes intact, `erroredTenantCount` or the walk time can differ per machine. The ready line is then flaky for a reason outside the code.
  - `createPool` there sets no `application_name`, so a child left running after a failure is invisible to `setup.ts`'s worker-detection guard and keeps looping.
  - A cold `tsx` start plus the first tick can approach the default 30-second test timeout.
- **Action.**
  - Assert on `failedTenantCount`/`erroredTenantCount` restricted to the cell's own tenants (or only that the heartbeat line appears and errored is not caused by 42501).
  - Set an explicit timeout.
  - Kill the child in `finally` and on timeout.
  - Pass a distinguishing `application_name` through the URL so the guard sees an orphan.

### T18. C9's preflight test: states, wiring and edge states are not buildable as written (Major, design)
- **Problem.**
  - The preflight reads `_prisma_migrations` over its own connection. The shared database's table cannot be edited to produce "report mode applied, flip pending", and a rolled-back transaction is invisible to the separate process. Without replaying migrations, the three states (fresh, flip pending, flip applied) need either a scratch database with a hand-made `_prisma_migrations` table, or a preflight whose decision is a pure function over rows (unit) with a thin runner.
  - "Recorded as applied" has edge states: `finished_at` null, `rolled_back_at` set (a failed migration).
  - The migration names inside the preflight are constants that can drift; a cell should assert both exist under `prisma/migrations`.
  - Nothing pins that the migrate task's command (`ecs.tf` runs `set -e; npx prisma migrate deploy; node scripts/audit-db-grants.mjs`) calls the preflight before migrate, or that `deploy.sh` forwards the variable. `deploy-rollback.test.mjs` and the HCL wiring tests are the places. The mutation row only covers the script.
- **Action.** Make the decision a pure function with a unit test for fresh, pending, applied and the failed-migration rows, plus the attested case. Add a wiring-test row for command order and one for the `deploy.sh` forwarding.

### T2. "Write absent" is vacuous for the harness-rolled-back cells (Minor, design) — continues T2; RT8
- **Problem.** `asApp` and `inRolledBackTx` roll back in `finally`, so a write is absent after the cell whether or not enforcement refused it. The 42501 and message assertions carry the proof, not the absence.
- **Action.** For those cells, say that the assertion is the 42501 plus the allow twin showing the write present (readable inside the allow twin's transaction before rollback). Keep "absent through `ctx.su`" only for cells that commit or abort the transaction themselves.

### T19. C1 convergence mutation row needs a replay mechanism (Minor, design)
- **Problem.** "Skip the convergence revoke, with a pre-seeded over-privileged role" requires running the migration's convergence block against a role the test over-privileged. `prisma migrate deploy` has already run, and the file is wrapped in `BEGIN; … COMMIT;`, so it cannot be executed inside the cell's transaction. Other cells use marked blocks (`-- BEGIN BACKFILL …`, `readBackfillBlock`).
- **Action.** Mark the convergence block and read it the same way, and say so in C1.

### T21. C7 arm-structure check may reject policies that exist today (Minor, design, needs-execution)
- **Problem.** "Every policy is the bypass call OR-ed with at most one tenant comparison, bypass first" has to hold for `tenants`, `mcp_clients` (NULL tenant is visible under bypass), `system_settings` (bypass-only) and any policy with a different shape. A text check over `pg_policy` text may false-positive in Block 1, which is fatal and not whitelisted in `pre-pr.sh`.
- **Action.** Run the regex over the real catalog before fixing its shape. Test it against the throwaway table's passing policy (case 0 calibration) and the existing policies.

## Answers to the specific questions

- **(a)**
  - `options` reaches the server through `pg`, and `pool-factory` only rejects `client_min_messages`. `assertRlsApplies` reads `current_user`, so it sees the probe.
  - The notice sink still sees reports on those connections: the listener attaches on pool connect.
  - `setup.ts`'s same-database check and the `application_name` worker detection are unaffected.
  - Parametrising the CLI suites over two URLs does not work as is (T9), and the privilege set is undefined (T20).
- **(b)** T17.
- **(c)** The wrapper sees text and values for the Prisma path. Appends do not race; truncation and role attributes are the issues (T5).
- **(d)** T10. Cleanup of the child on failure is not in the plan.
- **(e)** T18.
- **(f)** Yes: PUBLIC's EXECUTE appears in `has_function_privilege(role, …)`, so the expected set must be built as D2 ∪ what PUBLIC holds. Compute PUBLIC's part from `has_function_privilege('public', …)`. Table and column PUBLIC grants are empty in CI and dev.
- **(g)** Rows that hold: C1 twelfth column (exact-privilege cell), C1 drop `metadata`, C2 `AUDITED_ROLES`, C3 both, C4 INSERT on `audit_logs` (its denial cell; the exact-privilege cell also fires), C6 both, C7 arm swap and the "no exception is a pass" row, C8 prune, scripts and invalidation (given T9, T20), C9 (once T18 is built), C10, C11. Rows that do not hold: C2 `rolcanlogin` and C5 function-returns-false (T15), C5 audit-mode (T16), C7 D5 sentinel (T7).

# Recurring Issue Check

- R1: N/A.
- R2: N/A.
- R3: N/A.
- R4: N/A.
- R5: N/A.
- R6: N/A.
- R7: N/A.
- R8: N/A.
- R9: N/A.
- R10: N/A.
- R11: N/A.
- R12: N/A.
- R13: N/A.
- R14: T20 (owner-shaped privilege set).
- R15: N/A.
- R16: T9, T17, T18, T21.
- R17: N/A.
- R18: N/A.
- R19: T9 (`dbUser` expectations).
- R20: N/A.
- R21: N/A.
- R22: N/A.
- R23: N/A.
- R24: N/A.
- R25: N/A.
- R26 to R28: N/A.
- R29: N/A.
- R30: N/A.
- R31: T16, T17 (shared database mutation).
- R32: T10.
- R33: T18.
- R34: N/A.
- R35: C12 now has steps; T18 adds a test side.
- R36: N/A.
- R37: N/A.
- R38: N/A.
- R39: N/A.
- R40: N/A.
- R41: N/A.
- R42: T20 derive the owner's set from the catalog.
- R43: N/A.
- R44: T5 (CI step reading the evidence file).
- R45: T9 (CI time).
- R46: N/A.
- R47: N/A.
- R48: N/A.
- R49: T7 (D5 block), T15.
- R50: T5, T16.
- R51: N/A.
- R52: N/A.
- R53: N/A.
- R54: N/A.
- R55: N/A.
- R56: N/A.
- R57: N/A.
- RS1 to RS6: N/A (out of scope).
- RT1: N/A.
- RT2: T18, T19.
- RT3: N/A.
- RT4: N/A.
- RT5: T9 (the second run goes through the production CLI).
- RT6: T18 (preflight and its wiring).
- RT7: T7, T15, T16.
- RT8: T2.
- RT9: N/A.
- RT10: T20 (allow side of the probe set).
- RT11: T17, T10, T5.

```json
[
{"id":"T2","severity":"Minor","title":"Write-absent is vacuous for harness-rolled-back cells; assert 42501 plus allow twin","file":"src/__tests__/db-integration/team-key-rekey-writers.integration.test.ts","line":965,"adjacent":false,"escalate":null},
{"id":"T5","severity":"Major","title":"C11 consumer cannot resolve a dropped probe role's attributes; evidence file creation and truncation unspecified","file":null,"line":null,"adjacent":false,"escalate":null},
{"id":"T7","severity":"Major","title":"D5 block and its sentinel row cannot be shown to fail independently of ARM-ORDER; sentinel case vacuous per table","file":"scripts/rls-cross-tenant-verify.sql","line":790,"adjacent":false,"escalate":null},
{"id":"T9","severity":"Major","title":"Second run of CLI suites under role=probe breaks dbUser assertions and the conditional URL stub","file":"src/__tests__/db-integration/tenant-claim-cli.integration.test.ts","line":91,"adjacent":false,"escalate":null},
{"id":"T10","severity":"Major","title":"Boot cell on a shared database: all-tenant tick is environment-sensitive; orphan child and timeout","file":"scripts/audit-chain-verify-worker.ts","line":592,"adjacent":false,"escalate":null},
{"id":"T15","severity":"Major","title":"C2 and C5 mutation rows name tests that cannot fail for the stated reason; missing rows","file":"src/__tests__/db-integration/audit-db-grants.integration.test.ts","line":115,"adjacent":false,"escalate":null},
{"id":"T16","severity":"Major","title":"C5 audit-mode integration cell needs to un-flip the shared database; make the check a pure function","file":"scripts/audit-db-grants.mjs","line":null,"adjacent":false,"escalate":null},
{"id":"T17","severity":"Major","title":"Probe role lifecycle: cluster-global name collision, DROP OWNED BY, crash residue","file":null,"line":null,"adjacent":false,"escalate":null},
{"id":"T18","severity":"Major","title":"C9 preflight test states, failed-migration rows and migrate-task/deploy.sh wiring not buildable or pinned","file":"infra/terraform/ecs.tf","line":321,"adjacent":false,"escalate":null},
{"id":"T19","severity":"Minor","title":"C1 convergence mutation row needs a marked, replayable block","file":null,"line":null,"adjacent":false,"escalate":null},
{"id":"T20","severity":"Major","title":"Owner-shaped probe privilege set undefined (routines, sequences, schema, audit_logs); derive from owner ACL","file":null,"line":null,"adjacent":false,"escalate":null},
{"id":"T21","severity":"Minor","title":"C7 arm-structure check may reject existing policy shapes; Block 1 is fatal in pre-pr","file":"scripts/rls-cross-tenant-verify.sql","line":null,"adjacent":false,"escalate":null}
]
```

---

# Expert outputs (verbatim), round 3

## Functionality expert

Round 3 functionality review: no Critical or Major findings remain open in my scope. F13-F19 are all fixed correctly against the code. One Minor finding is open (F20).

F13: fixed. C9 now compares the attestation to the flip migration's directory name whenever that migration is not applied, and only an absent or empty `_prisma_migrations` passes without it. An upgrade that skips the report-mode release is therefore caught. "Applied" means `finished_at` set and `rolled_back_at` null.

F14: fixed. The mode audit passes in report mode only with a forwarded acknowledgement carrying a reason. A fix deploy after an un-flip can ship, using the same `deploy.sh` run-task overrides as C9.

F15: fixed. C9 lists the Dockerfile `COPY`, the `check-runtime-image-assets.mjs` entry, the `ecs.tf` command and the `deploy.sh` overrides, with wiring tests.

F16: fixed. The convergence block always sets CONNECTION LIMIT 10 and `rolconnlimit` joins the audit. With pool cap 2 and rolling overlap (up to two tasks per desired task), the limit of 10 holds for up to two desired tasks, as the plan states.

F17: fixed. The measure (a `git diff origin/main` of `tenant-rls-grants.ts` after the first full enforced run) is decidable, and the fallback is explicit.

F18: fixed. The consumer normalises table order, twin grants share evidence, `SET LOCAL ROLE` connections are recorded under their login user, and role attributes travel in the evidence file.

F19: fixed. D6's audit now reads the effective `client_min_messages`, which covers a server-level default.

Regression checks on the new text found no defects:
- A probe role that is a member of the table owner's role passes ownership checks.
- Every RLS table is FORCE, so the probe is not RLS-exempt.
- Superuser status is not inherited through role membership.
- `audit-db-grants` audits only the `AUDITED_ROLES`, so the probe's membership does not trip it.
- The RDS master can `ALTER ROLE … CONNECTION LIMIT` on a role it created. PostgreSQL 16's creator grant makes the master a member of the new role, not the reverse, so C1's "member of no role" check holds.
- After a successful flip, the preflight and the mode audit both pass with no variable set, so steady-state deploys are unaffected.

F20 — Minor — design — needs-execution — R41. The D6 effective `client_min_messages` read measures the audit's own session, which connects as the migration role. A value that role carries for itself can mask a server-level default, or fail the audit on a setting only that role has. The role-level and database-level values for the app roles are already read from `pg_db_role_setting` at `scripts/audit-db-grants.mjs:293-304`, so this is narrow. Fix: specify the read as `pg_settings` (value and `source`) and fail when the source is `configuration file`, `override`, `environment variable` or `command line` and the value is above `warning`. Settle in the first build by running it against a database with a server-level default.

## Recurring Issue Check
- R1: Checked — no issue.
- R2: Checked — no issue.
- R3: Checked — no issue.
- R4: N/A — no event dispatch.
- R5: N/A — no new multi-step DB writes.
- R6: N/A.
- R7: N/A.
- R8: N/A.
- R9: N/A.
- R10: N/A.
- R11: N/A.
- R12: N/A.
- R13: N/A.
- R14: Checked — F16 closed.
- R15: Checked — no issue.
- R16: Checked — no issue.
- R17: N/A.
- R18: Checked — F15 closed.
- R19: N/A.
- R20: N/A.
- R21: N/A.
- R22: N/A.
- R23: N/A.
- R24: Checked — no issue.
- R25: Checked — C11 producer and consumer.
- R26: N/A.
- R27: N/A.
- R28: N/A.
- R29: Checked — derived claims (pool arithmetic) re-derived.
- R30: N/A.
- R31: N/A.
- R32: Checked — boot cell present (C4).
- R33: Checked — no issue.
- R34: Checked — no issue.
- R35: Checked — manual-test artifact covers the new paths.
- R36: N/A.
- R37: N/A.
- R38: N/A.
- R39: N/A.
- R40: N/A.
- R41: Finding F20.
- R42: Checked — F18 closed.
- R43: N/A.
- R44: N/A.
- R45: N/A.
- R46: N/A.
- R47: N/A.
- R48: N/A.
- R49: Checked — F13 and F14 closed.
- R50: Checked — no issue.
- R51: N/A.
- R52: Checked — no issue.
- R53: N/A.
- R54: Checked — no issue.
- R55: N/A.
- R56: N/A.
- R57: N/A.
- RS1-RS6: N/A — out of scope.
- RT1-RT11: out of scope.

```json
[
  {"id":"F20","severity":"Minor","title":"D6 effective client_min_messages read measures the audit's own (migration role) session; specify pg_settings source","file":"scripts/audit-db-grants.mjs","line":293,"adjacent":false,"escalate":null}
]
```

## Security expert

## Security review, Round 3 (incremental): verify-worker-readonly-role-rls-enforce-plan

**No Critical or Major finding remains open in my scope. No findings.** Read-only; no database command run. Round-2 items S4 and S9-S14 are resolved or acceptably dispositioned. I re-read plan C1, C5, C8, C9 and the Round-2 dispositions.

## Verification of S4 and S9-S14

- **S4:** the reason is corrected and the scope is narrowed to SCIM and team removal. rotate-key has one client, and `rotate-key-dialog.tsx:74` already warns on `invalidationFailed`. SC6 is filed before the PR and linked from the E1 checklist. Resolved.
- **S9 (Skipped part), (c):** acceptable.
  - The in-migration ACL loop is not needed for safety. The migrate task runs `migrate deploy` then `audit-db-grants.mjs` under `set -e`, before any service update.
  - The audit compares effective privileges, so another grantor's grants, ownership and inherited grants show up as rows. Role settings are covered by its `pg_db_role_setting` item and, after S12, the effective `client_min_messages`.
  - Before the audit passes, the verifier is not in use: the new role is NOLOGIN until the bootstrap, and no secret key or task points at it. Only a pre-existing LOGIN role of that name would be exposed in the window, and that premise already means someone could connect as it.
  - The `ALTER … CONNECTION LIMIT` always-run block and the stated "a raise wedges the migrate task, it does not repair" are fine, because the wedge is loud.
  - Phase 2 should confirm, in the audit's own integration cell, that an owned object and a grant by a different grantor each produce a row. That is a test point, not a contract defect.
- **S10 and F14 reconciliation, (a):** an acceptable control.
  - Why the argv-only flag was wrong: after an un-flip the fix release could not deploy at all, so some forwarding is unavoidable.
  - What the control gives: it is explicit, carries a non-empty reason that the audit prints, is never defaulted (wiring test pinning the task definition and `deploy.sh`), and `--write` refuses in report mode, so a report-mode manifest cannot be laundered.
  - Residual:
    - The reason is unauthenticated free text.
    - It is not time-bounded.
    - An operator's shell can keep it exported. The wiring test cannot pin that.
    - The same operators can run the un-flip, so this adds no capability.
    - Each deploy in report mode prints the reason, which is the visible signal.
  - The residual is adequate. The honest scope of the control, stated in the plan ("detection waits for the next deploy and never runs on compose"), is correct.
- **S11:** taken. The value is bound to the flip migration name, "applied" is `finished_at` set and `rolled_back_at` null, and only an absent or empty migration table passes. The preflight reads `_prisma_migrations` through the migrate task's existing `MIGRATION_DATABASE_URL`, so it adds no privilege.
- **S12:** taken. The audit reads the effective `client_min_messages`.
- **S13, (b):** the member-of-owner shape is sound.
  - **Who can become the probe:** only a superuser or a member of the probe, and nothing is ever made a member of it. Membership gives the probe the owner's rights; it does not give the owner or anyone else the probe's. The owner can `SET ROLE` to the probe only if it is a superuser, as in dev and CI. In dev and CI the owner is a superuser, whose `rolsuper` attribute is not inherited. The probe holds the owner's object privileges by inheritance, not superuser status, so it stays subject to RLS (the plan's rolled-back probe confirms this). It is NOLOGIN with no ACL entries, so `DROP ROLE` removes it.
  - **No new path:** a leftover probe gives nobody a route they did not already have. A superuser could always do the same.
  - **Conditions that keep it safe:**
    - The sweep prefix must be specific enough not to match another role in a shared cluster.
    - `assertRlsApplies` stays, keyed on `current_user`.
    - The `options=-c role=` URL is only reachable where a test or operator writes it.
  - On RDS the owner is the NOSUPERUSER migration role. The probe then holds exactly its object privileges, which is the intended RDS-shaped state.
- **S14:** taken. Pool cap 2 sits under `CONNECTION LIMIT 10`, even with two overlapping tasks.

## Recurring Issue Check

- R1 Checked, no issue.
- R2 Checked, no issue.
- R3 Checked, no issue.
- R4 N/A.
- R5 Checked, no issue.
- R6 N/A.
- R7 N/A.
- R8 N/A.
- R9 N/A.
- R10 Checked, no issue.
- R11 N/A.
- R12 N/A.
- R13 N/A.
- R14 Checked. The grant set is minimal and sufficient. Over-privilege paths on a pre-existing role are adjudicated by the audit (S9 disposition).
- R15 Checked. Hardcoded role names follow the template. `current_database()` is used for CONNECT.
- R16 Checked, no issue.
- R17 Checked, no issue.
- R18 Checked, no issue.
- R19 N/A.
- R20 N/A.
- R21 N/A.
- R22 N/A.
- R23 N/A.
- R24 Checked, no issue.
- R25 N/A.
- R26 N/A.
- R27 N/A.
- R28 N/A.
- R29 Checked. The claims I rely on were re-derived by grep and Read in Round 2.
- R30 N/A.
- R31 N/A.
- R32 Checked, no issue.
- R33 Checked, no issue.
- R34 N/A.
- R35 Checked, no issue.
- R36 Checked. The acknowledgement is explicit, reasoned and never defaulted.
- R37 N/A.
- R38 Checked. The un-flip has an audit-visible exit.
- R39 N/A.
- R40 N/A.
- R41 N/A.
- R42 Checked, no issue.
- R43 Checked, no widening.
- R44 Checked, no issue.
- R45 N/A.
- R46 N/A.
- R47 Checked, no issue.
- R48 Checked, no issue.
- R49 Checked. The control classes are honest: the attestation checks that the operator attested, and C5 is a fail-closed gate against `setBypassGucs` code.
- R50 Checked. Round-2's S11 and S12 are resolved.
- R51 N/A.
- R52 Checked, no issue.
- R53 N/A.
- R54 Checked, no issue.
- R55 Checked, no issue.
- R56 N/A.
- R57 N/A.
- RS1 N/A.
- RS2 N/A.
- RS3 N/A.
- RS4 Checked, no issue.
- RS5 N/A.
- RS6 N/A.

```json
[]
```

## Testing expert

# Round 3 testing review (incremental, read-only)

**Open Critical/Major in my scope: two Major, no Critical.**
- T22 (evidence consumer fails on test-created login roles).
- T23 (probe-role prefix sweep can drop another run's live probe).
- T24 is Minor.

All Round 2 items (T2, T5, T7, T9, T10, T15 to T21) are otherwise fixed as the dispositions say. I checked these against the code:
- The ten `TENANT_*` grants in `scripts/tenant-domain.ts` are ten distinct members, matching the new file's "one cell per grant".
- T16, T18 and T19 now rest on pure functions or marked blocks, so each row can go red for its stated reason.
- T7's D5 pins are honestly declared as observation pins.
- T17/T20's membership-by-inheritance design avoids the ACL cleanup problem, and the orchestrator's probe covers its main behaviours.

## T22. C11 consumer "fails on a role with no attribute line" will fail CI on existing probe cells (Major, design, needs-execution) — RT11, R50
- **Problem.**
  - `tenant-claim.integration.test.ts` creates random-named LOGIN probe roles (~:400-470 and ~:1099-1165) and runs production writers on them through `createPool` and `createPrismaClient`.
  - The first one calls `setBypassRlsGucs(tx)` through the probe (~:446-454), the same statement the producer records.
  - C11 records the connection user (the random probe name) and writes attribute lines only for roles `setup.ts` knows and for probes made by the new probe helper. These cells use neither, so their evidence lines name roles with no attribute line.
  - The consumer fails the whole CI step on an unknown role. This has nothing to do with grant completeness.
- **Action.** Decide in the plan, then build and run once to confirm no other unlisted role appears. Either:
  - route these cells through the probe helper (so they write attribute lines), or
  - have the producer skip lines whose role is not NOSUPERUSER-resolvable by the file only if the role is a test-created one, recorded explicitly, or
  - make the consumer ignore a pair whose role is unknown only when its grant is not a `BYPASS_GRANT` member (those pairs carry no evidence anyway), and fail only for unknown roles that set a member's grant.

  The third option keeps the fail-closed intent where it matters.

## T23. Probe-role "prefix sweep" can drop a concurrent run's live probe (Major, design) — RT11
- **Problem.**
  - E5's reason for a random name is that two worktrees can run integration on one cluster at once. The helper "first sweeps any role with its prefix left by a crashed run". A role created by the other, still running worktree has the same prefix and is indistinguishable from crash residue.
  - The sweep drops it mid-run, and the other run's CLI connection then fails with `role "…" does not exist` at its next connect. That is a flake whose cause is in the neighbouring run.
- **Action.**
  - Put creation time in the name (for example `<prefix>_<epoch-ms>_<rand>`) and sweep only roles older than a bound well above the longest file (for example 1 hour).
  - Or sweep only roles with no entry in `pg_stat_activity.usename` and no connection holding them.
  - Add a cell (or a unit test on the sweep's selector) that a fresh role is not swept.

## T24. Boot cell: the heartbeat cannot show the seeded tenant was counted (Minor, prose, needs-execution)
- **Problem.** The `audit-chain-verify-heartbeat` line carries `tenantCount`, `verifiedTenantCount`, `erroredTenantCount` and `failedTenantCount` (audit-chain-verify-worker.ts:507-519), not tenant ids. "Counting at least the cell's seeded tenant" is always true once the sentinel exists. The discriminating checks are the other two in the sentence: no enumeration-failure line and no permission error on stderr.
- **Action.** Reword so the ready signal is the heartbeat line plus those two stderr checks, and add `verifiedTenantCount >= 1`. Nothing else in the plan depends on this.

## Recurring Issue Check

- R1 to R13: N/A.
- R14: T20's inheritance design is the fix; no gap found.
- R15: N/A.
- R16: T22.
- R17 to R30: N/A.
- R31: T23.
- R32: boot cell present (T24 wording).
- R33: N/A.
- R34: N/A.
- R35: N/A (steps listed in C12).
- R36 to R41: N/A.
- R42: N/A (evidence role set derived by the unknown-role failure, see T22).
- R43 to R49: N/A.
- R50: T22.
- R51 to R57: N/A.
- RS1 to RS6: N/A (out of scope).
- RT1: N/A.
- RT2: T24.
- RT3: N/A.
- RT4: N/A.
- RT5: OK.
- RT6: OK.
- RT7: rows re-pointed; no remaining row found that cannot go red.
- RT8: OK.
- RT9: N/A.
- RT10: OK.
- RT11: T22, T23.

```json
[
{"id":"T22","severity":"Major","title":"C11 consumer fails on unknown roles; existing tenant-claim login probes set the bypass without attribute lines","file":"src/__tests__/db-integration/tenant-claim.integration.test.ts","line":446,"adjacent":false,"escalate":null},
{"id":"T23","severity":"Major","title":"Probe-role prefix sweep can drop another worktree's live probe on the shared cluster","file":null,"line":null,"adjacent":false,"escalate":null},
{"id":"T24","severity":"Minor","title":"Boot cell heartbeat cannot show the seeded tenant was counted; reword the ready signal","file":"scripts/audit-chain-verify-worker.ts","line":507,"adjacent":false,"escalate":null}
]
```

---

# Expert outputs (verbatim), round 4

## Testing expert

# Round 4 testing review (narrow, read-only)

**No Critical or Major is open in my scope.** T22, T23 and T24 are resolved. One Minor is new (T25).

## The three fixes

- **T23 resolved.** The name carries its creation time, and the sweep removes only roles with the prefix that are older than an hour. A concurrent run's fresh probe survives, and the selector has a unit test for a fresh name. The one-hour bound is well above the 30-minute `integration` job cap. Both worktrees read the same machine clock for the timestamp, so skew is not a concern for the shared-cluster case in E5.
- **T24 resolved.** The ready signal is now the heartbeat line with `verifiedTenantCount >= 1`, neither an enumeration-failure line nor a permission error on stderr. The stderr checks are what discriminate: a column denial in the role makes every tenant error and prints a permission error. `verifiedTenantCount >= 1` is weak alone, because the sentinel is nearly always verified, but it does not need to carry the proof.
- **T22 resolved.** A line whose role has no attribute line counts as no evidence and is only tallied, so the existing login-probe cells in `tenant-claim.integration.test.ts` no longer fail the step.

## Does the T22 change open a hole?

Only a minor one, and it fails closed in the normal case.
- If the attribute lines for `setup.ts`'s own roles (for example `passwd_app`) were missing, every member would lose its evidence.
- The comparison then reports each member that has no evidence and is absent from the committed list. That is "missing from both", so the step fails.
- It would pass vacuously only if someone regenerated the committed list while the attribute lines were broken. That list would then contain every member.
- The remaining defect is that nothing asserts the known roles' attribute lines are present. See T25.

## T25. Consumer lacks a positive control for the known roles' attribute lines (Minor, design) — RT7
- **Problem.** The plan says unknown roles are tallied and not failed, but does not require the consumer to fail when a role `setup.ts` appends (the superuser, `passwd_app`, the worker roles, the verifier) has no attribute line. A broken append in `setup.ts` degrades the gate to "everything is unexercised", which a regenerated list would accept.
- **Action.** Fail when any role named in `setup.ts`'s known-role set lacks an attribute line, or when no line resolves to a NOSUPERUSER NOBYPASSRLS role at all. Add one unit case for it next to the existing both-direction cases. This is a wording-plus-one-test addition, not a redesign.

## Recurring Issue Check

- R1 to R13: N/A.
- R14: N/A.
- R15: N/A.
- R16: OK.
- R17 to R30: N/A.
- R31: OK (T23 closes the shared-cluster drop).
- R32: OK.
- R33: N/A.
- R34: N/A.
- R35: N/A.
- R36 to R41: N/A.
- R42: N/A.
- R43 to R49: N/A.
- R50: T25.
- R51 to R57: N/A.
- RS1 to RS6: N/A (out of scope).
- RT1: N/A.
- RT2: OK.
- RT3: N/A.
- RT4: N/A.
- RT5: OK.
- RT6: OK.
- RT7: T25.
- RT8: OK.
- RT9: N/A.
- RT10: OK.
- RT11: OK (T23 resolved).

```json
[
{"id":"T25","severity":"Minor","title":"C11 consumer has no positive control that setup.ts's known roles have attribute lines","file":null,"line":null,"adjacent":false,"escalate":null}
]
```
