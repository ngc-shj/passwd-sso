# Coding Deviation Log: verify-worker-readonly-role-rls-enforce

## Carried-Forward Plan Findings

### S4 (part) — stays open, as the plan accepted it

- The two sites that give their caller no failure signal (SCIM `Users/[id]` deprovisioning, team member removal) are unchanged. Follow-up issue `#1047` is filed (SC6).
- Anti-Deferral: worst case — a deprovisioned user's sessions and tokens survive when revocation throws. Likelihood — not raised by the flip: the `invalidateUserSessions` cell runs as `passwd_app` on an enforcing database over a row in each of the ten models and passes. Cost to fix here — a response-contract change for SCIM clients and a retry design.

### F20 — settled in Phase 2

- `clientMinMessagesViolations` treats every `pg_settings.source` other than `client`, `session`, `interactive` and `test` as server-level.
- Observed on the worktree database: the default reads `notice|default`; a session `SET` reads `session`. PostgreSQL rejects `fatal` and `panic` for this setting, so the levels above `warning` are `error` and `log`.
- Not observed: a value set in `postgresql.conf` or an RDS parameter group (source `configuration file`). The rule covers it by exclusion, not by a run.

### T21 — settled in Phase 2

- `[E-RLS-ARM-ORDER]` is `pg_get_expr(...) !~ ('^[( ]*SELECT rls_bypass_admits\(''' || relname || '''::text\)')` on both the USING and the WITH CHECK expression.
- Run over the live catalog before commit: 59 of 59 policies accepted, including the bypass-only and NULL-tenant ones. The negative test's calibration case (a policy with the arms swapped) is refused.

## Deviations

### D-1. The grant manifest was built by hand, not by `audit-db-grants --write`

- The session prompt asked for `--write` against the worktree database. That run wrote the worktree's database name (`passwd_sso_wt_947_921`) into the manifest and dropped two `passwd_app` default-ACL rows that exist only where CI's `ALTER DEFAULT PRIVILEGES` ran.
- The committed manifest is HEAD's manifest plus the verifier's rows and the `rolconnlimit` rows, each taken from the `--write` output.
- Consequence: auditing this worktree database reports those environment differences; CI's database is the reference.

### D-2. Files the plan did not list

- `scripts/checks/lib/function-resolver.mjs`: `rls-enforce-preflight.mjs` added to `NON_PRODUCTION_SCRIPTS`, or the function rule read its SQL as application code.
- `scripts/checks/check-runtime-image-assets.mjs` and its fixtures: the preflight is a runtime script of the migrate image.
- `scripts/checks/check-bypass-rls.mjs`: `POOL_RULE_ALLOWLIST` entries for the preflight, the probe-role helper, its test and the definer test (each with its reason), and one `FUNCTION_RULE_ALLOWLIST` entry for the negative test's un-flip case.
- `src/__tests__/db-integration/user-owned-rows-seed.ts`: seeds one row in each of the 22 models `realign` and `backfill-owning-column` strand. An enforcing bypass is consulted only for a table whose rows a statement examines, so without the rows those two cells would prove nothing for most of their grants.
- `src/__tests__/db-integration/role-url-consistency.ts`, `probe-role-names.ts`, `rls-grant-evidence-recorder.ts`: the pure halves of the harness checks, split out so they have unit tests.
- `helpers.ts`: `superuserConnectionString()` and `auditChainVerifierConnectionString()` exports.

### D-3. C10 covers one more site than listed

- `vault/delegation`'s rollback-delete catch also swallowed its error; it now logs `delegation.create.rollback_delete_failed` at error level. Same class as the listed sites.

### D-4. C7: the smoke script was run on a scratch database through a psql shim

- The host has no `psql`. `rls-cross-tenant-verify.sql` and the negative test were run with a shim that execs `psql` in the database container, against a scratch copy of the worktree database that was dropped afterwards.
- Negative-test cases 18 (a policy that admits instead of refusing) and 19 (report mode is detected) have their own runners. Case 18's withheld-table region raises no WARNING, which the shared runner would report first; case 19 replaces the real `rls_bypass_enforced()`, so it is gated like cases 15 and 16 and restores the function in the same case.
- The refusal check is named `[E-RLS-REFUSAL]`; the plan left the name open.
- Negative-test case 7 fails on a database without CI's `ALTER DEFAULT PRIVILEGES … TO passwd_app`. It passes where that statement ran; CI is the reference.

### D-5. C8: one cell kept, one script run out of process

- The existing `team_member_key_prune` owner-swap cell was left as it is; it already runs the routine under a NOBYPASSRLS owner and asserts the refusal.
- `migrate-account-tokens-to-encrypted` runs as a child process because its `main()` is not exported. The harness records evidence in-process only, so `ACCOUNT_TOKEN_MIGRATION` is listed as unexercised in the C11 baseline although the cell runs it as the probe role, and the cell has no red proof (the mutation targets a module the child loads itself).
- `tenantClaimEvent` in `TENANT_CLAIM_BINDING_READ` and `TENANT_CLAIM_BINDING_WRITE` cannot be red-proven: `tenant_claim_events` has no RLS policy, so no bypass is consulted for it.

### D-6. C11: 33 grants have no restricted-role evidence

- Of 110 `BYPASS_GRANT` members, 77 were set by a NOSUPERUSER NOBYPASSRLS role in the full suite. The other 33 are listed in `scripts/checks/rls-grant-evidence-baseline.txt`; the check fails when a grant leaves either set unannounced.
- Anti-Deferral: worst case — one of the 33 grants omits a table and production refuses that path after the flip. Likelihood — bounded by the production zero window the attestation stands for, which measures the same paths as report lines. Cost to fix here — a restricted-role integration cell per grant (routes that today have only mocked unit tests).
- Recovery if it happens: the un-flip statement in `docs/operations/deployment.md`.

### D-7. The citation gate is red on the plan-review log only

- The plan, this log and the manual-test file carry no `file:line` citation. The 50 issues the gate reports all come from the plan-review log, which keeps the experts' outputs verbatim: they cite `main` as it was when the plan was reviewed, and many by bare file name.
- Left as written. Rewriting a reviewer's verbatim output to match the code after the change would misstate what was reviewed.

### D-8. Verification gaps

- No AWS call was made. The ECS command override, the `deploy.sh` `--overrides` forwarding, the Terraform secret wiring and the circuit-breaker behaviour described in `docs/operations/deployment.md` are covered by text-level tests (`migrate-task-wiring.test.ts`, the deploy-rollback tests) and by reading, not by a deploy.
- `terraform fmt -check -recursive` passes locally. `terraform validate` and `plan` were not run: they need an initialised backend.
- `typecheck:test` is not a root script; test files are type-checked by `npm run typecheck`.
