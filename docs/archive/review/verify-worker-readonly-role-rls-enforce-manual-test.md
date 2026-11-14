# Manual test: verify-worker-readonly-role-rls-enforce

Covers the deployment-facing parts of this change (#947, #921):
- migration `20261111000000_audit_chain_verifier_role` (the role, created `NOLOGIN`) and `scripts/bootstrap-rds-roles.mjs` giving it `LOGIN`;
- the verify worker reading `AUDIT_CHAIN_VERIFY_DATABASE_URL` (no `DATABASE_URL` fallback in production) and the ECS task's secret reference;
- migration `20261114000100_rls_bypass_enforce` (`public.rls_bypass_enforced()` returns true) and the deploy gate around it: `scripts/rls-enforce-preflight.mjs`, the `RLS_ENFORCE_ATTESTED` and `RLS_REPORT_MODE_ACK` forwarding in `scripts/deploy.sh`, the mode audit in `scripts/audit-db-grants.mjs`.

## Deploy note
- **The flip applies at the deploy, not at merge.** From the moment run 1 of step 3 migrates, the previous tasks serve an enforcing database; a code rollback returns to those tasks and does not undo it.
- **The attestation is a statement by the operator.** The preflight checks that it was made, not that it is true. The E1 checklist in `docs/operations/deployment.md` ("One-time upgrade: audit-chain verifier role and RLS enforcement") is what it stands for.
- **Docker compose installs flip on upgrade** with no attestation and no audit; the un-flip is in `docs/operations/deployment.md`.

## Pre-conditions
- A staging environment on AWS (ECS + RDS, `enable_monitoring = true`) deployed from the release before this change, which has applied `20261019000000_rls_bypass_admits_report_mode`, with at least one row in `sessions` and `audit_logs` for two tenants.
- `AWS_REGION`, `ECR_URL` and `TF_VAR_FILE` exported, a clean worktree at the commit under test, and `cosign`/KMS access as `deploy.sh` requires.
- A way to run SQL from inside the VPC as the RDS master (the migration role), as `passwd_app` and as `passwd_audit_chain_verifier` (the app image has no `psql`; use ECS Exec on a task as in `infra/terraform/README.md` "Creating the DB roles on RDS", with a `pg` script, or a host in the VPC). SQL below is written for `psql`.
- The five role passwords. The passwords of `passwd_app` and the three older workers are the userinfo of the existing URLs.
- CloudWatch access to the five log groups (`/ecs/<name_prefix>/app`, `audit-outbox-worker`, `retention-gc-worker`, `audit-anchor-publisher`, `audit-chain-verify-worker`).

## Steps
1. Record the before state (master):
   - `SELECT count(*), max(finished_at) FROM _prisma_migrations;` — note both values;
   - `SELECT rolname FROM pg_roles WHERE rolname = 'passwd_audit_chain_verifier';` — 0 rows;
   - `SELECT public.rls_bypass_enforced();` — `false`.
2. Deploy without the attestation, then with a wrong one:
   - `./scripts/deploy.sh`; then `RLS_ENFORCE_ATTESTED=20261114000100_rls_bypass_enforc ./scripts/deploy.sh`.
   - Each exits non-zero at the migrate step ("ERROR: migration exited 1"). The migrate task log (`aws logs tail /ecs/<name_prefix>/app --log-stream-name-prefix migrate/ --since 1h --region <region>`) contains `rls-enforce-preflight: REFUSED: 20261114000100_rls_bypass_enforce is not applied on this database and RLS_ENFORCE_ATTESTED is not set to it.` and `No migration was applied.`
   - Re-run step 1's queries: `_prisma_migrations` count and `max(finished_at)` unchanged, no role, function still `false`. No service was updated (`aws ecs describe-services` shows each service's task definition unchanged).
3. The two-run deploy:
   1. Add `AUDIT_CHAIN_VERIFY_DATABASE_URL` to the app secret by read-merge-write (`infra/terraform/README.md` "Adding a key to an existing app secret"), naming `passwd_audit_chain_verifier` and a new password. Keep the password in a secure store: steps 3.3 and 7 need it.
   2. `RLS_ENFORCE_ATTESTED=20261114000100_rls_bypass_enforce ./scripts/deploy.sh`. The log shows `==> Forwarding to the migrate task: RLS_ENFORCE_ATTESTED` and `rls-enforce-preflight: OK (RLS_ENFORCE_ATTESTED attests the pending 20261114000100_rls_bypass_enforce)`, both migrations apply, and the audit fails with exactly `UNEXPECTED_GRANT: ROLEATTR:passwd_audit_chain_verifier rolcanlogin false` and `MISSING_GRANT: ROLEATTR:passwd_audit_chain_verifier rolcanlogin true`. `deploy.sh` exits at the migrate step; no service is updated.
   3. Run `scripts/bootstrap-rds-roles.mjs` through ECS Exec with `PASSWD_APP_PASSWORD`, `PASSWD_OUTBOX_WORKER_PASSWORD`, `PASSWD_RETENTION_GC_WORKER_PASSWORD`, `PASSWD_ANCHOR_PUBLISHER_PASSWORD` and `PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD` exported. It prints `bootstrap-rds-roles: done`.
   4. `./scripts/deploy.sh` (no attestation). The preflight prints `OK (20261114000100_rls_bypass_enforce is already applied)`, the audit passes, the services roll and settle.
4. The verify worker as the new role:
   - `aws logs tail /ecs/<name_prefix>/audit-chain-verify-worker --since 2h --filter-pattern audit-chain-verify-heartbeat --region <region>`: a heartbeat with `_logType: "audit-chain-verify-heartbeat"`, `verifiedTenantCount` equal to `tenantCount`, and `erroredTenantCount: 0`. The worker ticks at start, so the first one is within minutes.
   - Master: `SELECT usename, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY usename;` lists `passwd_audit_chain_verifier` with at most 2 connections per running task, beside `passwd_app` and the other worker roles.
5. The mode: master `SELECT public.rls_bypass_enforced();` returns `true`.
6. Canary, once per log group, then the alarm:
   - As `passwd_app`: `BEGIN; SET LOCAL app.bypass_rls = 'on'; SET LOCAL app.bypass_tables = 'users'; SELECT id FROM sessions LIMIT 1; ROLLBACK;` The select fails with `ERROR: RLS_BYPASS_NOT_GRANTED: sessions` (SQLSTATE 42501), after `WARNING: rls_bypass_not_granted table=sessions purpose=…`.
   - Through each service's own pool (a one-off task of its task definition whose command opens a bypass with a grant omitting a table): `aws logs filter-log-events --region <region> --log-group-name /ecs/<name_prefix>/<group> --filter-pattern '{ $._logType = "rls.bypass_not_granted" }'` returns the line for that group.
   - `RlsBypassNotGranted` (namespace `<name_prefix>/App`) rises by the count of lines; the `<name_prefix>-rls-bypass-not-granted` alarm goes to ALARM and notifies the alarms SNS topic, then returns to OK within a few evaluation periods of 5 minutes once the canaries stop.
7. A deploy with the secret key absent:
   - Remove `AUDIT_CHAIN_VERIFY_DATABASE_URL` from the app secret (read-merge-write with `jq 'del(.AUDIT_CHAIN_VERIFY_DATABASE_URL)'`), then `./scripts/deploy.sh`.
   - The new verify task does not start (its secret reference does not resolve; the service events say so). The circuit breaker keeps the service's previous revision, so `aws ecs describe-services` still shows the verify service running tasks, and step 4's heartbeat keeps arriving as `passwd_audit_chain_verifier`. `deploy.sh` exits non-zero and restores every service to its pre-deploy revision.
   - Put the key back (the password kept in step 3.1) and run `./scripts/deploy.sh`; it completes.
8. The un-flip and the audit that then fails:
   - Master: `CREATE OR REPLACE FUNCTION public.rls_bypass_enforced() RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT false $$;` then `SELECT public.rls_bypass_enforced();` returns `false`. Repeat the step 6 canary SQL: the select now returns a row (or none) with the WARNING and no error.
   - `./scripts/deploy.sh`: the migrate task fails the audit with `RLS_ENFORCE_MODE: public.rls_bypass_enforced() is not true: the RLS bypass is in report mode (set RLS_REPORT_MODE_ACK to a reason to deploy anyway)`; `deploy.sh` exits at the migrate step.
   - `RLS_REPORT_MODE_ACK="manual test: un-flip drill" ./scripts/deploy.sh`: the audit passes and the task log prints `WARNING: RLS bypass is in REPORT mode, acknowledged: manual test: un-flip drill`.
   - Re-flip (master): the same statement with `SELECT true`. `SELECT public.rls_bypass_enforced();` returns `true`, and `./scripts/deploy.sh` with no acknowledgement passes.

## Expected result
- Step 2 changes nothing: no migration, no role, no service update.
- Step 3 leaves no gap in the verify worker's heartbeats beyond one tick, and ends with the worker connected as `passwd_audit_chain_verifier`.
- No request fails because of the flip under normal traffic, and `RlsBypassNotGranted` stays 0 except for the step 6 canaries.
- Every canary is refused with 42501 on an enforcing database and counted in the group it ran in.
- Not covered here: a refusal that depends on a query plan the staging data does not produce, and any production traffic shape (that is the E1 window).

## Adversarial scenarios
Run after step 5, on the enforcing database. Seed rows in `sessions` and in `audit_logs` of two tenants first.
1. **The verifier cannot write.** As `passwd_audit_chain_verifier`: `UPDATE audit_logs SET metadata = metadata WHERE false;` and `DELETE FROM audit_logs WHERE false;` and `INSERT INTO audit_chain_anchors (tenant_id) VALUES (gen_random_uuid());` each fail with 42501 `permission denied`. No row changes.
2. **The verifier cannot read another column or table.** `SELECT action FROM audit_logs LIMIT 1;`, `SELECT * FROM audit_logs LIMIT 1;`, `SELECT name FROM tenants LIMIT 1;` and `SELECT count(*) FROM users;` each fail with 42501. Allow twin on the same connection: `SELECT id, tenant_id, metadata FROM audit_logs LIMIT 1;` succeeds when the bypass is on for `audit_logs` (scenario 3), or returns no rows without it.
3. **Stated residual: the verifier can widen its own tenant scope.** In one transaction as the verifier: `BEGIN; SET LOCAL app.bypass_rls = 'on'; SET LOCAL app.bypass_tables = 'audit_logs'; SELECT tenant_id, count(*) FROM audit_logs GROUP BY tenant_id; ROLLBACK;` succeeds and shows rows of both seeded tenants. This is the documented limit (`docs/security/security-review.md` section 5): the role bounds tables, columns and writes, not tenant scope. The same transaction naming a table outside the eleven columns' tables (for example `SELECT count(*) FROM users`) is still 42501.
4. **A bypass with no table list is refused.** As `passwd_app`: `BEGIN; SET LOCAL app.bypass_rls = 'on'; SELECT id FROM sessions LIMIT 1; ROLLBACK;` fails with 42501 `RLS_BYPASS_NOT_GRANTED: sessions`. Allow twin: the same with `SET LOCAL app.bypass_tables = 'sessions'` returns a row.
5. **A wrong attestation is refused.** Covered by step 2 (a one-character-short value); it is repeatable only before the flip applies. A value with a trailing space or lowercase change is refused the same way, since the preflight compares for equality with the directory name.
6. **A role-level setting cannot silence the report channel.** On staging, as the master: `ALTER ROLE passwd_app SET client_min_messages = error;` then `./scripts/deploy.sh`: the audit fails on a denied role setting. Remove it with `ALTER ROLE passwd_app RESET client_min_messages;` before continuing.

## Rollback
- **Code:** `./scripts/deploy.sh --rollback-to <image>` re-points the services at a previous image without a migration. The database stays enforcing, so the target must be at or above the release carrying `20261019000000_rls_bypass_admits_report_mode`. The previous verify revision connects as `passwd_app` through `DATABASE_URL`, which still works.
- **The flip:** the un-flip statement of step 8, run as the migration role. Later deploys then need `RLS_REPORT_MODE_ACK` until the function is restored with `SELECT true`. A hand-run statement leaves no migration row.
- **The verify task:** the circuit breaker (step 7) or `--rollback-to` returns the service to its previous revision. The role and its grants stay; removing them is a new migration.
