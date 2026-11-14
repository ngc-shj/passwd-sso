# Plan: verify-worker-readonly-role-rls-enforce

Implements #947 (a read-only database role for the audit-chain verify worker) and #921 (RLS bypass grants: report mode to enforce, SC5 of #911). One PR, branch `fix/verify-worker-readonly-role-rls-enforce`. Finding IDs in parentheses refer to `verify-worker-readonly-role-rls-enforce-review.md`.

## Project context

- **Type:** web app (Next.js 16, Prisma 7, PostgreSQL 16 with FORCE RLS) plus four worker processes and operator scripts.
- **Test infrastructure:** unit, integration (real Postgres, `ci-integration.yml`), E2E, CI/CD (`rls-smoke`, static gates).
- **Verification environment constraints:**
  - **E1. Production observation is not reachable from the repository.** Three #921 preconditions are facts about production: `RlsBypassNotGranted` at 0 over an agreed window with the alarm armed; a positive canary seen in each log group before that window; production and its rollback target at or above the report-mode release. Classification: `blocked-deferred`. The operator attests them at the deploy that applies the flip (C9).
    - Anti-Deferral: worst case if skipped — a production path whose grant omits a table fails with 42501 after the deploy. Likelihood — the suite already fails on any report, so test-driven paths are clean; the rest is what the window measures. Cost to fix here — impossible; it needs production telemetry.
    - The window does not measure everything: a refusal depends on the query plan (deviation D6 of #911), so a plan change after the window can refuse a statement that never reported. The un-flip (C5) is the recovery.
  - **E2. On RDS the migration role is NOSUPERUSER NOBYPASSRLS**, so SECURITY DEFINER bodies and operator scripts are subject to RLS there; in dev and CI the owner is a superuser. Stand-in: an owner-shaped NOBYPASSRLS probe role (C8). `verifiable-CI`.
  - **E3. No `terraform plan/apply`.** Terraform changes are checked by the HCL-parsing wiring tests. `verifiable-CI`; the apply is deploy-time.
  - **E4. The `e2e` job connects as a superuser**, so E2E is not evidence for either issue.
  - **E5. Roles are cluster-global.** The migration creates the role NOLOGIN. A local integration run, and the manifest regeneration, need it given LOGIN and the test password once (as the anchor publisher's is). The verifier cells check `rolcanlogin` first and fail with the command to run; they are never skipped (T11).

## Objective

1. The verify worker connects as a role that can read the columns its statements name and nothing else.
2. A bypassed statement that examines a row of an RLS table outside its grant is refused (42501) instead of reported and admitted, and the suite, rls-smoke and the RDS-shaped cells run with refusal on.

## Design decisions

- **D1. The flip migration ships in this PR. The gate is the deploy that applies it, not the merge** (F2, S2).
  - Merging does not deploy: production changes when an operator runs `scripts/deploy.sh`, which migrates first. C9 makes that deploy refuse a pending flip without an explicit attestation.
  - Decided by: which artifact carries the enforce evidence. With the flip in the tree, every database the suite and rls-smoke run on is enforcing, so the whole suite is the enforce pass, permanently.
  - Alternative: ship the preconditions only, flip CI's ephemeral databases with a post-migrate statement, and release the flip migration later. What it satisfies that D1 does not: a hotfix deploy from main that cannot flip, and a compose upgrade that does not flip. What it costs: the tested state is no longer the shipped migrations, every developer database needs a hand-run statement, and #921 stays open.
  - **Stop rule** (F17): if making the suite pass under enforcement requires adding a table to a production grant, the flip leaves this PR. Reason: during a rollout the old tasks serve an already-enforcing database, and a code rollback returns to them; neither carries a grant fixed in this release.
    - Measure: after the first full enforced suite run in Phase 2 (C5 and C6 in place), `git diff origin/main -- src/lib/tenant-rls-grants.ts` shows a model added to an existing `BYPASS_GRANT` member that production code sets.
    - If it fires: the PR keeps C1-C4, C10 and the grant fix; C5-C9 and C11 move, with the flip, to the follow-up issue. Nothing enforcing ships.
  - **Self-hosted (`docker compose up`)** flips on upgrade with no attestation and no alarm. The release is marked breaking, and the upgrade note says so and gives the un-flip.
  - Three #921 items exist only to run an enforce pass against a database that ships report mode: the `RLS_PASS` selector, the ephemeral flip script with a `COMMENT ON DATABASE` marker, and the scratch-database procedure. Under D1 they have no subject. Their purposes are carried by C6: the suite refuses to run unless the database is enforcing, and unless every role URL names the same database as the superuser URL (F6).
- **D2. Column-level SELECT for the verifier.** Probed on this worktree's database in a rolled-back transaction: a NOBYPASSRLS role with `SELECT (id)` on `tenants`, `SELECT (tenant_id, chain_seq, prev_hash)` on `audit_chain_anchors`, `SELECT (id, tenant_id, created_at, chain_seq, event_hash, chain_prev_hash, metadata)` on `audit_logs` and EXECUTE on the two `rls_bypass_*` functions runs the worker's four reads under both the tenant context and the bypass grant; `SELECT name FROM tenants`, `SELECT action FROM audit_logs`, `SELECT *`, UPDATE, DELETE and a read of `users` are each `permission denied`.
  - `metadata` is needed: it is part of the hashed payload (`src/lib/audit/audit-chain-verify.ts`).
  - Cost: a future verifier query naming another column fails with 42501 until a migration grants it; the tick counts as errored, which the existing alert keys on.
- **D3. In production the worker has no `DATABASE_URL` fallback**, as the anchor publisher has none. A fallback would silently reinstate `passwd_app`.
- **D4. Flip mechanics (probed, same database, rolled back).** `CREATE OR REPLACE FUNCTION public.rls_bypass_enforced() … SELECT true` keeps the EXECUTE grants and the PUBLIC revoke, and takes effect in a session that had already planned and run a statement through `rls_bypass_admits`. A granted read and a no-bypass tenant read are unchanged. Other sessions pick it up through the same plan invalidation; that was not probed separately (F10).
- **D5. The OR-arm order question (T3-19).** Every policy is `(SELECT rls_bypass_admits('<t>')) OR tenant_id = (SELECT …::uuid)`. Probed: with the bypass on, the table ungranted and `app.tenant_id` equal to the row's tenant, the statement is refused; the plan is `Filter: ($0 OR (tenant_id = $1))`.
  - PostgreSQL does not promise this order. If the tenant arm ran first and matched, `rls_bypass_admits` would not be called: no refusal and no report. The rows admitted would be those of the bypass's `app.tenant_id`: none for the default (NIL), the caller's tenant where one is passed, and for the anchor publisher the system sentinel's rows (S7).
  - C7 pins the observed order with a cell for a seeded tenant and one for the sentinel, and a catalog check on the arm structure.
- **D6. The report stays.** The WARNING is raised before the exception, and the test sink keeps failing a test on any report it did not take. A refusal swallowed by a catch is therefore still a test failure and still a production metric, as long as the report channel is open. A role-level or database-level `client_min_messages` that closes it is already refused by `scripts/audit-db-grants.mjs` (its `pg_db_role_setting` check), which the migrate task runs on every deploy. The audit also reads `client_min_messages` from `pg_settings` with its source, and fails when a server-level source sets it above `warning`, which covers a default such as an RDS parameter group (S12, F19). Which sources count is settled in the first build against a server-level default (F20). That is the #921 precondition; no on-connect read is added (T4, F10). Residuals: a setting changed between deploys, until the next audit; and compose installs, which do not run the audit.

## Contracts

### C1. Role `passwd_audit_chain_verifier` and its grants (one migration, before the flip)

- Creates the role `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION` when absent.
- A marked convergence block then runs whether or not the role existed (S1, T19): `ALTER ROLE … CONNECTION LIMIT 10`; revoke every privilege on tables, sequences and routines in `public`, on the schema, and the default privileges; then CONNECT on `current_database()`, USAGE on `public`, the column grants of D2, EXECUTE on the two functions. It raises unless the role has none of `rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole`, `rolreplication` and is a member of no role. A raise stops the migrate task; it does not repair the role.
- What the block cannot see (S9) — a grant by another grantor, objects the role owns, role settings, other schemas — is adjudicated by `audit-db-grants`, which the migrate task runs after the migrations and before any service is updated. It compares effective privileges, so ownership and inherited grants show as rows. It gains `rolconnlimit` (F16).
- **Invariant (schema-enforced):** the role's effective privileges on `public` are the eleven columns of D2 and EXECUTE on what PUBLIC and those two grants give. No write, no sequence, no other column.
- **Control class:** enforceable boundary over tables, columns and writes. It does not bound tenant scope: the role can set the bypass GUCs itself and then read those eleven columns for every tenant, `metadata` included (S6). **Adjudication authority:** PostgreSQL's privilege check.
- **Residuals, stated in `security-review.md`:** like every role, it can take advisory locks whose keys are public constants and so stall the publisher (S5). Role-level timeouts are not set: they are session defaults the holder of the credential can override, so they would bound nothing. The connection limit is enforced by the server.
- **Acceptance:**
  - an integration cell enumerates, through the `has_*_privilege` functions, every column, table, sequence and routine of `public` and the schema itself, and the result equals D2 plus what PUBLIC holds (computed, not listed) (T3);
  - a second cell over-grants the role inside a rolled-back transaction, replays the marked block, and gets the same result;
  - the committed manifest carries the role's rows, `rolcanlogin true` and the connection limit, and `audit-db-grants-role-state.test.mjs` pins them (F1, T15).

### C2. Every surface that enumerates the worker roles gains the new role

- **Member set**, from `grep -rIl passwd_anchor_publisher` outside `node_modules`, `.next`, `.git`, `docs/archive`, extended with the gates a role-creating migration must satisfy (F3):
  - `infra/postgres/initdb/` (a new numbered file cloned from the retention-GC one: statement-text settings, empty-password guard, NOLOGIN when unset) and `docker-compose.yml` (the db service's env);
  - `scripts/bootstrap-rds-roles.mjs` `ROLES` and header; `scripts/audit-db-grants.mjs` `AUDITED_ROLES`; `scripts/checks/db-grants-manifest.json`;
  - `scripts/checks/app-role-denied-privileges.json`: the entries every worker role carries (`tenant_claim_events`, its sequence, `tenant_claims`) (F4);
  - `scripts/checks/migration-rls-dml-baseline.txt` (the `GRANT CONNECT … current_database()` entry) and the transaction baseline, as the other role migrations have;
  - `.github/workflows/ci-integration.yml` (password env, `ALTER ROLE … LOGIN PASSWORD`), and `infra/postgres/**` added to its relevance filter (T11);
  - `scripts/set-audit-chain-verifier-password.sh` and its row in `set-role-password.test.mjs`;
  - `helpers.ts` (a `TestRole` and its fallback password), `setup.ts` (the EXECUTE check, which today also omits `passwd_anchor_publisher`);
  - list-pinning tests: `bootstrap-rds-roles.integration.test.ts`, `app-role-denied-privileges.integration.test.ts`, `revoke-public-connect.integration.test.ts`, `audit-db-grants-role-state.test.mjs`, the `backup-db` globals fixtures;
  - `scripts/env-allowlist.ts` (`PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD`), `.env.example`, both READMEs, `docs/setup/docker/en.md`, `docs/operations/dev-host-migration.md` (the per-role CONNECT list);
  - count prose: "four" passwords or roles in `deployment.md`, `infra/terraform/README.md` and its `.ja` twin.
- **Control class:** fail-closed verification gate (the audit and the list-pinning tests).

### C3. Worker wiring

- `validateWorkerEnv` reports `AUDIT_CHAIN_VERIFY_DATABASE_URL` `missing` when `NODE_ENV` is `production` and it is unset, whatever `DATABASE_URL` holds; `main()` takes the URL from the same decision. The pool is capped at 2 connections: with a rolling deploy two tasks overlap per desired task, so the role's limit of 10 holds for up to two desired tasks (S14, F16). The existing fallback tests are split by `NODE_ENV` (F7).
- The URL enters `envObject`, `env-descriptions.ts` and `.env.example`, as #947 asks; the worker's other settings stay where they are.
- `infra/terraform/ecs.tf`: the verify task's secret reads the app secret's `AUDIT_CHAIN_VERIFY_DATABASE_URL` key (one line and its comment; `#1020`, unmerged, edits the same file). `terraform.tfvars.example`, the Terraform READMEs and `docs/setup/aws/en.md` follow, including that the role password is taken from that URL's userinfo.
- `worker-bundle-smoke.json` (URL user), `worker-policy-manifest.json` (`dbRole`), `audit-anchor-wiring.test.ts`, `CLAUDE.md`, the worker's header comment.
- Not touched: `/api/maintenance/audit-chain-verify`, which runs as `passwd_app`.
- **Consumer walkthrough:** the ECS task reads `{AUDIT_CHAIN_VERIFY_DATABASE_URL}` from the app secret and passes it to `createPool`. `deploy.sh` and its rollback read only the task-definition ARN. A rollback returns to the revision keyed on `DATABASE_URL`, which still works as `passwd_app`.

### C4. Verifier tests run as the new role

- `audit-chain-verify-worker-rls.integration.test.ts` drives `runTick`, `verifyTenantChain` and `verifyChainUnderSentinelGrant` through a pool connected as the role (RT5), with `assertRlsApplies`. A tampered chain is still detected.
- Denial cells, each paired with the allow case on the same connection (RT10): a column outside D2, a table outside D2, INSERT/UPDATE/DELETE on each of the three tables.
- **Boot cell** (T10, R32): the worker process is spawned with only `AUDIT_CHAIN_VERIFY_DATABASE_URL` set to the role's URL and a short tick. Ready signal: one `audit-chain-verify-heartbeat` line with `verifiedTenantCount` of at least 1, and neither an enumeration-failure line nor a permission error on stderr (T24). Other tenants' chains in a shared database are not asserted (T10). Then SIGTERM, and `shutdown clean`. The cell sets its own timeout, kills the child in `finally`, and names the connection through `application_name`.

### C5. The flip

- One migration, after C1's: `CREATE OR REPLACE FUNCTION public.rls_bypass_enforced()` returning `true`, with the report-mode definition's signature, `LANGUAGE sql IMMUTABLE PARALLEL SAFE` (F8). Nothing else in it.
- **Control class:** fail-closed verification gate against code that sets the bypass through `setBypassGucs` with a grant that omits a table. **Adjudication authority:** the PostgreSQL policy evaluator.
- **Not covered by the flip**, listed in the rewritten docs (S6): code that writes `app.bypass_tables` itself; superuser or BYPASSRLS connections; SECURITY DEFINER bodies whose owner is RLS-exempt (dev and CI); the `enforce_tenant_id_from_context` trigger's bypass short-circuit; tables without RLS.
- **Un-flip** (S3): `docs/operations/deployment.md` gives the statement (the same function returning `false`), run as the migration role. A hand-run statement leaves no migration row, so `scripts/audit-db-grants.mjs` makes the state visible: it fails when the function is absent or returns false.
  - The fix release after an un-flip must still deploy (F14). The audit passes in report mode only when the acknowledgement variable carries a non-empty reason, which it prints. `deploy.sh` forwards it as it forwards C9's attestation; neither the task definition nor `deploy.sh` may default it, and a wiring test pins that (S10). `--write` refuses in report mode whatever is set.
  - The decision is a pure function, unit-tested for enforcing, report mode, acknowledged report mode and an absent function. The integration cell covers only the enforcing database: testing the other arms there would mean un-flipping a shared database (T16).
  - Detection waits for the next deploy and never runs on compose.
- **Forbidden pattern:** `CREATE (OR REPLACE )?FUNCTION public\.rls_bypass_enforced` outside `prisma/migrations`, `docs/operations` and the one negative-test case of C7 — reason: the mode is migration-owned. Owner: the existing function rule of `check-bypass-rls.mjs` (T12).

### C6. The integration suite runs enforcing

- `setup.ts` refuses to run unless `SELECT public.rls_bypass_enforced()` is true, and unless each role's connection string names the host, port and database of the superuser one (F6).
- **`expectBypassRefusal(fn)`** (T1): runs `fn`, requires it to reject with SQLSTATE 42501 and a message naming `RLS_BYPASS_NOT_GRANTED: <table>`, takes the reports raised meanwhile whether or not `fn` threw, and returns both. It has its own unit cell, including the case where `fn` resolves (the helper fails).
- **Rules for a refusal cell** (T2):
  - on a raw connection the refused statement runs under a savepoint that is rolled back before anything else runs;
  - in a Prisma interactive transaction the refused statement is the last one;
  - where the cell's own transaction commits or aborts, "the write is absent" is read afterwards through the superuser client; where the harness rolls the transaction back anyway, absence proves nothing, and the proof is the 42501 plus the allow twin showing the write present;
  - no `.catch(() => undefined)`: the error is captured and asserted.
- **Member set of cells that today expect admission of an ungranted reach** (from `expectBypassNotices(`, `collectNotices(`, `.on("notice"`, direct `set_config('app.bypass_rls'` as a NOBYPASSRLS role, and assertions on `enforced`; test names, not line numbers, since the edit moves them):
  - `rls-bypass-grants`: the six report cells and the two old-code cells;
  - `audit-anchor-publisher` (the grant without `audit_outbox`); `team-key-rekey-writers` and `team-tenant-departure` (the table-list controls); `share-departure` (the public-serve control); `team-member-key-prune` (the report cell and the owner-swap cell, whose post-state asserts `enforced: false`); `departed-member-operator-scripts` (two mutated-runbook cells); `tenants-rls` (case e); `definer-audit-functions-grant` (the grant without `audit_logs`).
  - Not members: `key-version-guard` (superuser pools); the allow twins of the cells above.
- Each becomes a refusal cell and keeps its allow twin. The two `team-member-key-prune` cells seed their own rows instead of relying on earlier cells (T13).
- The old-code cells become: a bypass with no `app.bypass_tables` is refused. The cell guarding the 22P02 regression (a bypass with no `app.tenant_id` on a connection whose GUC reverted to `''`) is kept with its table granted.

### C7. rls-smoke runs enforcing

- `rls-cross-tenant-verify.sql`:
  - Block 1 asserts `public.rls_bypass_enforced()` is true and still `IMMUTABLE PARALLEL SAFE` (`[E-RLS-ENFORCED]`), and that in every policy the bypass call is the first OR arm (`[E-RLS-ARM-ORDER]`). The check's shape is fixed in Phase 2 against the real catalog, including the bypass-only and NULL-tenant policies (T21).
  - The one-table-withheld block runs each table in its own sub-block with an exception handler: SQLSTATE 42501 is the pass; no exception raises a new code. The WARNING still reaches the client before the handler runs, so `rls-verify-run.sh` keeps asserting the WARNING set per region. The table list is the block's existing `pg_policy` discovery, and `rls-cross-tenant-coverage.sql` already asserts each has a seeded row. This is the per-table refusal set and the seed-all fixture of #921.
- The D5 pins are integration cells, not rls-smoke blocks (T7): bypass on, the table withheld, `app.tenant_id` set to the seeded row's tenant; and the same on `tenants` with the sentinel id. They record today's evaluation order. No mutation can turn them red short of changing PostgreSQL; the check that can fail is `[E-RLS-ARM-ORDER]`.
- `rls-cross-tenant-negative-test.sh` gains one case per new code (T7). The `[E-RLS-ENFORCED]` case replaces the real function and restores it in the same case, behind the existing `RLS_NEGATIVE_MUTATE_REAL_POLICY` switch (CI's ephemeral database only), with a scoped entry in the function rule's allowlist.
- `pre-pr.sh`'s whitelist and `pre-pr-rls-whitelist.test.mjs` follow.

### C8. RDS-shaped cells

- **Owner-shaped probe role** (T17, T20, S13): `NOLOGIN NOSUPERUSER NOBYPASSRLS`, a member of the table owner's role, so it holds exactly the owner's privileges by inheritance and nothing is listed by hand. Probed (rolled back): as that role `current_user` is the probe, it is not RLS-exempt, it holds the owner's DELETE on `audit_logs` and EXECUTE on `rls_bypass_admits`, a no-context read of `users` sees no rows, and an ungranted bypassed read raises the report.
  - It holds no ACL entries of its own, so `DROP ROLE` removes it. The name carries its creation time and a random suffix; the helper drops it in `finally`. A sweep removes only roles with the prefix that are older than an hour, so a concurrent run on the same cluster keeps its probe (T23); the selector has a unit test for a fresh name. No role is ever made a member of it.
  - A connection becomes it with `SET LOCAL ROLE`, or for code that opens its own pool, through the connection string's `options` (`-c role=…`), which `checkedConfig` accepts.
- **SECURITY DEFINER routines** (member set from `grep -rn "SECURITY DEFINER" prisma/migrations`, latest definition each), with the owner swapped to the probe role inside a rolled-back transaction (T8):
  - `team_member_key_prune`: runs under its production grant; refused under a grant missing a table its body scans. The existing owner-swap cell is extended, not rebuilt.
  - `audit_log_purge`, `audit_log_tenant_migrate`: the body touches only `audit_logs`, which the routine's own guard already checks. The cell proves the allow arm: with a seeded row, the body runs as a NOBYPASSRLS owner under the `auditLog` grant and the write is present. The refusal under a grant without `audit_logs` is the guard's, and the cell says so.
- **Operator scripts as the probe role** (T9):
  - `tenant-domain`: a new file with one cell per `TENANT_*` grant the CLI names, each invoking the subcommand over seeded rows with the CLI's URL pointed at the probe role. The existing suites are not re-run: they assert the recorded `dbUser` against the superuser and would double a long job (T9). C11's record shows which of the ten were reached;
  - `migrate-webhook-secrets-v1-to-v2` and `migrate-account-tokens-to-encrypted` each complete over seeded rows.
  - What makes these cells non-vacuous: `assertRlsApplies` on the connection, rows seeded in the tables the script scans, and one refused ungranted read on the same connection showing enforcement is live for that role. The proof that each can fail is its mutation row (drop a model from the script's grant).
- **`invalidateUserSessions`:** as `passwd_app`, with a row seeded in each of the ten models of `USER_SESSION_INVALIDATION`, it resolves and every row is revoked or deleted.
- Trigger and invoker-function bodies are not enumerated separately (F9): the database adjudicates them when a test runs the statement that fires them.

### C9. The deploy that applies the flip requires an attestation

- A preflight runs in the migrate task before `prisma migrate deploy`. It refuses, before any migration is applied, when the flip migration is not applied and the attestation variable does not equal the flip migration's directory name (S11). Applied means `finished_at` set and `rolled_back_at` null. Only a fresh database passes without it: no migration table, or an empty one (F13). `deploy.sh` forwards the variable to the task when the operator exports it.
- The decision is a pure function over the migration rows and the variable, unit-tested for fresh, pending, applied, a failed row, a wrong value and the right one (T18). A test asserts both migration names exist under `prisma/migrations`.
- Surfaces (F15): the script, its `COPY` in the `Dockerfile` and entry in `check-runtime-image-assets.mjs`, the migrate command in `ecs.tf`, the run-task overrides in `deploy.sh`. Wiring tests pin that the command runs the preflight before the migration, that `deploy.sh` forwards the two variables, and that nothing defaults them.
- **Control class:** fail-closed verification gate on the AWS deploy path. It checks that the operator attested, not that the attestation is true. Compose and other launchers do not run it (D1).
- **Consumer walkthrough:** `deploy.sh` reads the exported variable and passes it in the run-task overrides; the preflight reads it and `_prisma_migrations`; a refusal exits non-zero, which `deploy.sh` already treats as a failed migration before any service is updated.
- **Existing RDS, order** (F1), following the anchor publisher's one-time upgrade: add the secret key; run `deploy.sh` with the attestation, which migrates (the flip included) and stops at the grant audit because the new role is NOLOGIN; run the bootstrap with five passwords; re-run `deploy.sh`. Between the two runs the previous tasks serve the enforcing database.

### C10. Best-effort revocation catches log at error level

- **Member set, by class** (S4): call sites under `src` that open a bypass to revoke or delete credential or session state inside a `try`/`.catch` that does not rethrow. Derived in Phase 2 from the `withBypassRls` and `invalidateUserSessions*` call sites; known members: `vault/rotate-key` (no log today), `vault/delegation` (the old-session revoke, warn today), SCIM `Users/[id]` (three sites), team member removal, the two WebAuthn credential routes, `member-passkey-revoke`.
- Each logs at error level with `errorLogFields`. `vault/rotate-key` keeps recording `invalidationFailed` in its audit row. Unit tests assert the log on rejection for the sites that change.
- See Carried-Forward Plan Findings for the part of S4 not taken.

### C11. Per-grant evidence record

- **Producer:** when `RLS_GRANT_EVIDENCE_FILE` is set, the harness's existing wrapper of `Client.prototype.query` recognises the `setBypassGucs` statement and appends one JSON line: purpose, table list, and the connection's effective role (the `role` option when the connection string sets one, else its user; never the URL). A connection that changes role with `SET LOCAL ROLE` is recorded under its login user, which under-counts. It issues no query of its own and records no other statement or parameter. It lives under `src/__tests__/db-integration` only.
- Role attributes travel in the same file (T5): `setup.ts` appends one line per role it knows, and the probe helper one for each probe it creates. The harness only appends; the CI step names a fresh path.
- **Consumer:** a check run in `ci-integration.yml` after the suite step has passed. It reads only the file. A line whose role has no attribute line counts as no evidence and is tallied in the output; it does not fail the step, because existing cells set the bypass on login roles they create themselves (T22). It does fail when a role `setup.ts` is meant to describe has no attribute line, or when no line resolves to a NOSUPERUSER NOBYPASSRLS role (T25). It maps each (purpose, tables) pair, table order normalised, to the `BYPASS_GRANT` members that have it (members sharing a pair share evidence; F18), and compares the members with no NOSUPERUSER NOBYPASSRLS evidence against a committed list. It fails when a member is missing from both, when a listed member now has evidence, and when the file is absent or empty. Its comparison is a pure function with a unit test for each direction (T5, F5).
- A filtered local run does not set the variable, so nothing is compared.
- **What evidence means** (T6, F11): the grant was set on an RLS-subject connection in a suite run that passed, where any report or refusal fails a test. It does not show that a production call site set it, or that every table of the grant was examined. The committed list is therefore a lower bound on what rests on production observation (E1).
- **Control class:** fail-closed verification gate over that coverage statement.

### C12. Documentation

- Report-mode sentences rewritten to the enforced state, with C5's not-covered list. Member set from `grep -rnI -iE "report mode|until enforce|once enforce|#921|rls_bypass_enforced" --exclude-dir=archive docs src scripts infra`, migrations excluded (immutable): `security-review.md`, `tenant-boundary-matrix.md`, `threat-model.md`, `key-retention-policy.md`, `retention-gc-worker.md`, `alerts.md`, the headers of `check-bypass-rls.mjs`, `tenant-rls-grants.ts`, `tenant-rls-purpose.ts`, `pool-factory.ts`, `monitoring.tf`, `rls-cross-tenant-verify.sql`, `destructive-migration-baseline.txt`, and test titles that say "report mode".
- `deployment.md`: the verifier role; C9's order and attestation with the E1 checklist; the canary on an enforcing database (the statement is refused, the WARNING still counts); the un-flip; ad-hoc SQL as the table owner must name its tables.
- `alerts.md`: the publisher log group, filters and alarm already exist for all five groups (`monitoring.tf`), which closes that #921 item (F6).
- A manual-test artifact (R35): bootstrap the role, add the secret key, the two-run deploy, the expected heartbeat as the new role, a deploy without the attestation (refused, nothing migrated), a deploy with the secret key absent (the previous verify task keeps running), the un-flip and the audit that then fails.
- PR body: the deploy gate first, then C11's list. Commit type marked breaking.

## Testing strategy

Each mutation is applied alone to a scratch copy and must turn the named test red on a green base.

| Contract | Mutation | Red test |
|---|---|---|
| C1 | grant `SELECT` on a twelfth column | exact-privilege cell |
| C1 | drop `metadata` from the grant | C4 walk cell |
| C1 | the convergence block's revoke removed | the replay cell |
| C2 | remove the role from `AUDITED_ROLES` | role-state test |
| C2 | remove the manifest's `rolcanlogin` row, or one column row | `audit-db-grants-role-state.test.mjs` |
| C3 | production fallback to `DATABASE_URL` restored | worker env test (`NODE_ENV=production`) |
| C3 | task secret points back at `DATABASE_URL` | wiring test |
| C4 | grant the role INSERT on `audit_logs` | its denial cell |
| C4 | the worker's production fallback restored and the URL unset | boot cell |
| C5 | the flip migration returns `false` | `setup.ts` refusal; rls-smoke `[E-RLS-ENFORCED]` |
| C5 | the `[E-RLS-ENFORCED]` check removed | its negative-test case |
| C5 | `audit-db-grants` stops checking the mode | mode-decision unit test |
| C6 | a role URL names another database | `setup.ts` refusal (unit over the comparison) |
| C6 | `expectBypassRefusal` accepts a resolving `fn` | its unit cell |
| C6 | a production grant drops a table a seeded cell reads | that cell, with 42501 |
| C7 | a policy's arms swapped | `[E-RLS-ARM-ORDER]` |
| C7 | the withheld-table sub-block treats "no exception" as a pass | negative-test case |
| C8 | `team_member_key_prune`'s grant drops a scanned table | owner-swap cell |
| C8 | a migrate script's grant drops a model | its probe-role cell |
| C8 | `USER_SESSION_INVALIDATION` drops a model | the invalidation cell |
| C9 | the preflight ignores a pending flip, or accepts any value | decision unit test |
| C9 | the migrate command runs the migration first; `deploy.sh` stops forwarding | wiring tests |
| C10 | the log removed | route unit test |
| C11 | an unexercised grant removed from the list; a listed grant gains evidence | comparison unit test, both directions |

Before reporting complete: `npx vitest run`, `npx next build`, `npm run test:integration` (on this worktree's database), rls-smoke through `pre-pr.sh`, and every static gate `pre-pr.sh` runs.

## Considerations & constraints

- **Risk:** a production path no test drives, with an incomplete grant, fails after the deploy. Gated by E1's attestation; recovered by the un-flip.
- **Risk:** `#1020` and `#1035` are unmerged and touch `ecs.tf`, the wiring tests and a static gate. Changes there stay minimal.

### Scope contract

- **SC1.** Compose and k8s services for the verify worker and the publisher (their own issue). This PR creates the role in initdb but adds no service.
- **SC2.** A login role per grant, and any defence against code that issues its own `set_config` (rejected in #911).
- **SC3.** The retention-GC bypass-state fakes (deviation entry of #911).
- **SC4.** Per-worker ECS task roles.
- **SC5.** Running the production canaries and the zero window (E1; operator).
- **SC6.** Making SCIM deprovisioning and team member removal fail or retry when revocation fails (S4; follow-up issue filed before the PR, linked from the E1 checklist).
- **SC7.** A second, WARNING-independent metric for refusals (a filter on error logs carrying 42501) (S8; follow-up issue).

## Carried-Forward Plan Findings

- **S4 (part) — Accepted.** Asked: the sites that swallow a failed revocation should fail or retry.
  - `vault/rotate-key`: its only client, `rotate-key-dialog.tsx`, already reads `invalidationFailed` from the response and warns the user; C10 adds the operator's error log. No further change.
  - SCIM `Users/[id]` and team member removal: the caller (an IdP, an admin) gets no failure signal.
  - Anti-Deferral: worst case — a deprovisioned user's sessions and tokens survive when revocation throws. Likelihood — unchanged by the flip once C8's cell shows the grant complete over all ten models; today any database error has the same effect. Cost to fix here — a response-contract change for SCIM clients and a retry design, neither part of #947 or #921.
  - Settled by: SC6's issue.
- **F20 — Minor, needs-execution — carried to Phase 2.** Which `pg_settings` sources the audit treats as server-level for `client_min_messages`.
  - Anti-Deferral: worst case — the audit misses a server-level default, or fails on a value only the migration role carries. Likelihood — low; role and database settings are already read from `pg_db_role_setting`. Cost to fix now — none available on paper; it needs the query run against a server-level default.
  - Settled by: running the audit against a database with `client_min_messages` set at the server level, in the first build of C5.
- **T21 — Minor, needs-execution — carried to Phase 2.** The exact shape of `[E-RLS-ARM-ORDER]`.
  - Anti-Deferral: worst case — the check rejects a policy that exists today, and Block 1 is fatal. Likelihood — real for the bypass-only and NULL-tenant policies. Cost to fix now — none on paper; it needs the expression run over the live catalog.
  - Settled by: running the check over every policy in `pg_policies` and the negative test's calibration case before it is committed.

## User operation scenarios

- **Operator, fresh RDS:** bootstraps five roles, migrates, deploys. No attestation is asked. The verify worker starts as the new role and its heartbeat reports every tenant verified.
- **Operator, existing RDS:** C9's order. A deploy without the attestation applies nothing.
- **Operator, hotfix from main before the window closes:** the preflight refuses; the operator either attests or deploys from a commit before the flip.
- **Operator, ad-hoc SQL as the table owner on RDS:** a bypass without `app.bypass_tables` is refused; the runbooks already name their tables.
- **Self-hosted, `docker compose up`:** the database flips with the upgrade.
- **Developer:** `npm run db:migrate` flips the local database. A branch whose grants predate report mode is refused under bypass.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Verifier role, convergence and column grants | locked |
| C2 | Role enumerated on every surface | locked |
| C3 | Worker env and Terraform wiring | locked |
| C4 | Verifier tests and boot as the new role | locked |
| C5 | The flip migration, un-flip and mode audit | locked |
| C6 | Integration suite enforcing | locked |
| C7 | rls-smoke enforcing | locked |
| C8 | RDS-shaped cells | locked |
| C9 | Deploy attestation preflight | locked |
| C10 | Error logging at best-effort catches | locked |
| C11 | Per-grant evidence record | locked |
| C12 | Documentation | locked |
