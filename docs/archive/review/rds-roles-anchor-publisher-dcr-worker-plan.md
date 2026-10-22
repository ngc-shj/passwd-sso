# Plan: rds-roles-anchor-publisher-dcr-worker

Issue: `#935` (SC6 of the tenants RLS work, `docs/archive/review/tenants-table-rls-plan.md`).
Branch: `feat/rds-roles-anchor-publisher-dcr-worker`, base `origin/main` 083899746.
Revision 6 — after plan-review round 5 (`rds-roles-anchor-publisher-dcr-worker-review.md`).

## Project context

- Type: `mixed` (Next.js web app + Node scripts + Prisma migrations + Terraform/ECS deployment).
- Test infrastructure: `unit + integration + E2E + CI/CD`. Integration tests run against a real
  PostgreSQL 16 (`npm run test:integration`, `ci-integration.yml`).
- Verification environment constraints:
  - **E1** — no Amazon RDS instance is available. RDS's master user is not a superuser
    (`docs/setup/aws/en.md` "RDS master users are not SUPERUSER"): `ALTER ROLE … NOSUPERUSER /
    NOBYPASSRLS / NOREPLICATION` fails with 42501 even as a no-op, while `CREATE ROLE … NOSUPERUSER`
    succeeds. Locally this is reproduced by running the code as a NOSUPERUSER CREATEROLE role
    (verifiable-local); other RDS-only behaviour stays blocked-deferred. Plan-stage probe on the
    dev DB (PostgreSQL 16, inside `BEGIN … ROLLBACK`, `SET LOCAL ROLE` to a NOSUPERUSER CREATEROLE
    role that created the target): the full-attribute `ALTER ROLE` failed with "Only roles with the
    SUPERUSER attribute may change the SUPERUSER attribute"; `ALTER ROLE … WITH LOGIN NOCREATEDB
    NOCREATEROLE PASSWORD …` and `… WITH NOLOGIN NOCREATEDB NOCREATEROLE PASSWORD NULL` succeeded.
  - **E2** — the ECS migrate task (`prisma migrate deploy; node scripts/audit-db-grants.mjs`) and
    `scripts/deploy.sh` cannot be run; the same two commands run locally against the dev DB.

## Objective

Two roles hold privileges (both read `tenants`) but sit outside the RDS role convergence
(`ROLES` in `scripts/bootstrap-rds-roles.mjs`) and the grant audit (`AUDITED_ROLES` in
`scripts/audit-db-grants.mjs`):

- `passwd_anchor_publisher` — the audit-anchor publisher's role (`scripts/audit-anchor-publisher.ts`,
  `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`).
- `passwd_dcr_cleanup_worker` — unused since the retention GC absorbed DCR cleanup, yet still
  LOGIN-capable (initdb 03 and the CI setup give it a password) with CONNECT, schema USAGE,
  `SELECT, DELETE` on `mcp_clients`, `SELECT, INSERT` on `audit_outbox`, `SELECT` on `tenants`,
  EXECUTE on `rls_bypass_*`.

Decisions (user, this session): retire the DCR role (NOLOGIN, no password, no grants, role kept)
and audit it in that state; bring the anchor publisher fully under convergence with LOGIN,
including making `convergeRole` work on RDS (a pre-existing defect this depends on).

## Requirements

- R1. Bootstrap converges every login role, the anchor publisher included, and works on RDS for
  roles that already exist.
- R2. A migration retires the DCR role on every database, and runs on RDS.
- R3. The grant audit covers both roles; the DCR role's retired state is asserted prescriptively,
  in compare mode AND in `--write` mode, so regenerating the manifest cannot record a re-enabled
  role.
- R4. No path re-enables the DCR role: initdb, CI setup, restore runbook, docs.
- R5. An existing RDS deployment can be upgraded with a documented procedure that fits
  `scripts/deploy.sh`; the anchor publisher's password is generated and kept in Secrets Manager.

## Technical approach

- Retirement is written once, in SQL (the migration); the audit checks it. Bootstrap runs before
  migrations on a fresh RDS, when the DCR role does not exist yet.
- `convergeRole` keeps `CREATE ROLE … <all attrs>` (allowed on RDS) and narrows `ALTER ROLE` to the
  clauses a non-superuser CREATEROLE role may issue. The attributes it can no longer write are
  still asserted afterwards, so a role escalated out of band stops the run instead of passing.
- The retired-role predicate is a pure exported function over audit keys, so it is unit-testable
  against the committed manifest without a database.

## Contracts

### C1 — `convergeRole` works on RDS; the anchor publisher is a converged role

- `convergeRole(client, name, password)` (exported, unchanged signature):
  - absent → `CREATE ROLE <name> WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
    NOREPLICATION PASSWORD <pw>`;
  - present, `current_user` a superuser (`pg_roles.rolsuper` for `current_user`, which is what
    PostgreSQL checks — not `session_user`, which `SET ROLE` leaves unchanged) → the full
    `ALTER ROLE <name> WITH <ROLE_ATTRS> PASSWORD <pw>` as today, demoting any escalated attribute
    (dev, CI, self-hosted; existing T3);
  - present, `current_user` not a superuser (RDS) → preflight before any statement carrying the
    password is sent (A3, R3-S2 — a refused `ALTER … PASSWORD` is logged with the password): throw
    if the target's `rolsuper` / `rolbypassrls` / `rolreplication` is true (only a real superuser —
    AWS support on RDS — can clear it, and a non-superuser may not alter a SUPERUSER role at all);
    throw unless `pg_has_role(current_user, <name>, 'MEMBER WITH ADMIN OPTION')`, naming the
    missing ADMIN OPTION. Then `ALTER ROLE <name> WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD <pw>`
    — never a SUPERUSER / BYPASSRLS / REPLICATION clause;
  - memberships: for each `pg_auth_members` row with this member, `REVOKE <role> FROM <name>
    GRANTED BY <grantor>`; then re-query and throw if any remains (PG16 records the grantor; a
    REVOKE without it removes nothing for another grantor's grant, and lacking ADMIN raises 42501);
  - then all six `ROLE_ATTR_EXPECTATIONS` asserted; a true `rolsuper` / `rolbypassrls` /
    `rolreplication` throws, naming the attribute and stating that only a real superuser (AWS
    support on RDS) can clear it.
- `ROLES` (exported) gains `{ name: "passwd_anchor_publisher", pwEnv: "PASSWD_ANCHOR_PUBLISHER_PASSWORD" }`.
- The worker schema-privilege loop becomes an exported `grantWorkerSchemaPrivileges(client,
  roles = ROLES.filter((r) => r.name !== "passwd_app").map((r) => r.name))`.
- A full run without `PASSWD_ANCHOR_PUBLISHER_PASSWORD` exits 1 before connecting.
- Control class: enforceable boundary for every attribute, the password and memberships when run
  as a superuser; as a non-superuser (RDS), enforceable for LOGIN, CREATEDB, CREATEROLE, password
  and memberships, and a fail-closed verification gate for SUPERUSER / BYPASSRLS / REPLICATION
  (checked only; repair needs a real superuser). Durability between runs is C3.
- Member-set (R42), from code: login-role connection strings —
  `git grep -ohE "[A-Z_]*_DATABASE_URL\b|\bDATABASE_URL\b" -- src/lib/env-schema.ts src/workers
  'scripts/*.ts' | sort | uniq -c` → `DATABASE_URL` (passwd_app), `OUTBOX_WORKER_DATABASE_URL`,
  `RETENTION_GC_DATABASE_URL`, `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`; `AUDIT_CHAIN_VERIFY_DATABASE_URL`
  falls back to `DATABASE_URL` (passwd_app), `APP_DATABASE_URL` is the test harness's passwd_app,
  `MIGRATION_DATABASE_URL` the superuser. Roles created anywhere —
  `git grep -ohE 'CREATE ROLE "?[a-z_]+' -- prisma/migrations infra/postgres/initdb | sort | uniq -c`
  → the four login roles, `passwd_dcr_cleanup_worker`, `jackson_user` (SC4).
- Acceptance. Stand-in cases each run inside `BEGIN … ROLLBACK` on the superuser client: create
  the stand-in (NOSUPERUSER CREATEROLE) and, as it (`SET LOCAL ROLE`), the target, so the stand-in
  holds ADMIN OPTION exactly as the RDS master does over roles it created; the stand-in name is
  also added to the probe-role cleanup.
  - converges an existing target as the stand-in; red before the change with the message
    "Only roles with the SUPERUSER attribute may change the SUPERUSER attribute" asserted;
  - a target with `rolsuper`, `rolbypassrls` or `rolreplication` set by the real superuser (one
    case each) → throws naming that attribute and the superuser-only repair, no `ALTER … PASSWORD`
    was sent, and the attribute is unchanged;
  - a target the stand-in lacks ADMIN OPTION on → throws naming it, and no `ALTER … PASSWORD` was
    sent. The statement recorder wraps the superuser client, delegates `escapeLiteral`, passes
    every query through, and the test asserts the preflight's `pg_has_role` query IS in the log
    (positive control) and nothing matching `/PASSWORD/i` is;
  - a membership granted by the real superuser into a role the stand-in has no ADMIN on → PG16
    refuses the REVOKE (42501, probe-verified); convergeRole throws naming the membership, and the
    `pg_auth_members` row is still present;
  - a membership granted by the stand-in (into a role it created) → zero rows afterwards;
  - existing T1–T5 unchanged and passing — they run as the superuser, so T3 still demotes;
  - `grantWorkerSchemaPrivileges` default covers the anchor publisher and excludes passwd_app
    (recorder test, T9 style); EXECUTE on `rls_bypass_*` reaches the anchor publisher;
  - cross-file equality: `ROLES` names == `AUDITED_ROLES` − `RETIRED_ROLES`;
  - missing-password exit: child env sets `PASSWD_ANCHOR_PUBLISHER_PASSWORD: ""` explicitly (CI
    sets it job-wide), an unreachable URL → status 1, stderr contains
    `PASSWD_ANCHOR_PUBLISHER_PASSWORD is required`, and no connection error.

### C2 — migration retires `passwd_dcr_cleanup_worker`

- New migration `20261023010000_retire_dcr_cleanup_worker_role`, one `BEGIN; … COMMIT;`
  (migration-transaction gate), guarded by role existence, RDS-safe (no SUPERUSER / BYPASSRLS /
  REPLICATION clause — those are already false since 20260428170853 created the role with them,
  and C3 asserts them):
  - `ALTER ROLE … WITH NOLOGIN NOCREATEDB NOCREATEROLE PASSWORD NULL`;
  - revoke, with `GRANTED BY <grantor>` from `pg_auth_members`, every row where the role is the
    member, and every row where it is the granted role AND `inherit_option OR set_option` is true;
    then RAISE if any such row remains. An ADMIN-only row (`admin_option` true, `inherit_option`
    and `set_option` false) into the role is left alone: PG16 gives the creating CREATEROLE role
    exactly that row (probe-verified — grantor the bootstrap superuser), it confers none of the
    role's privileges, and on RDS it is the master's own management grant, which the master cannot
    revoke as `rdsadmin`;
  - `REVOKE ALL` on all tables, sequences, routines in every non-system schema, on those schemas,
    and on `current_database()`;
  - for every `pg_default_acl` row whose ACL names the role: RAISE naming the owner when
    `pg_has_role(current_user, <owner>, 'MEMBER')` is false (a non-superuser may only alter its own
    roles' defaults — fail with a clear message instead of a mid-statement 42501), else
    `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> [IN SCHEMA <s>] REVOKE ALL ON <type> FROM <role>`;
  - RAISE if the role owns any object (`pg_shdepend` deptype `o`) — REVOKE cannot remove an owner's
    rights.
  - On RDS the migration role is the master; it holds ADMIN OPTION over this role because the
    master created it (migration 20260428170853). A role restored from another cluster's globals
    would not satisfy that; the membership RAISE and the 42501 on `ALTER ROLE` then stop the
    migration rather than leave it half-retired.
- Control class: enforceable boundary (the engine refuses login; the ACLs are gone).
- Acceptance (with the PUBLIC baseline — PUBLIC holds USAGE on schema `public`, TEMP on the
  database, and EXECUTE on default-PUBLIC routines, so effective-privilege functions report those):
  `pg_authid.rolcanlogin = false` and `rolpassword IS NULL`; not a member of any role; no
  privilege-bearing (`inherit_option OR set_option`) member of it; no ACL entry
  (`aclexplode`) naming the role on any table, sequence, routine, schema, database, default ACL;
  owns nothing; `has_database_privilege(…, 'CONNECT')` false.
- Kept test: the migration file's own `BEGIN;`/`COMMIT;` would commit an outer test transaction,
  so the test first asserts `analyze(sql)` from `scripts/checks/check-migration-transaction.mjs`
  (the gate's own tokenizer) reports exactly one BEGIN, one COMMIT, no ROLLBACK, then strips the
  first and last statements and runs the body inside a transaction rolled back in `finally`:
  - re-arm the pre-migration state on the real role (LOGIN, the original grants, a membership each
    way, a default ACL), run the body, assert the acceptance;
  - creator case: rename the real role aside, re-create it as a NOSUPERUSER CREATEROLE stand-in
    (`SET LOCAL ROLE`), `RESET ROLE`; assert the stand-in's row into it exists with admin=t,
    inherit=f, set=f (precondition); run the body as the superuser; assert the row is still there;
    over `readLiveGrants(client)` on the same in-transaction client assert the key list contains
    `MEMBER:<stand-in>\tpasswd_dcr_cleanup_worker\tadmin=t,inherit=f,set=f` (positive control) and
    that the predicate's violations restricted to keys naming `passwd_dcr_cleanup_worker` are empty
    (not the global set, which other shared-DB state could redden). Running the body under the RDS
    master's own identity stays E1-deferred;
  - owned-object case: a table owned by the role → the body raises, message asserted;
  - absent case: `ALTER ROLE passwd_dcr_cleanup_worker RENAME TO <probe>` inside the transaction
    (never DROP), run the body → no-op;
  - after each ROLLBACK, assert the real role exists and is at rest (residue check).

### C3 — audit covers both roles; retired state asserted prescriptively

- `AUDITED_ROLES` gains both roles. The audit requires every audited role to exist (`has_*`
  functions raise on an unknown role); that is fail-closed and stated, not handled.
- `RETIRED_ROLES = ["passwd_dcr_cleanup_worker"]`; startup fails unless `RETIRED_ROLES ⊆
  AUDITED_ROLES`.
- Exported pure `roleStateViolations(keys, { auditedRoles, retiredRoles })` → offending keys, and
  an exported pure `assertRetiredSubset(auditedRoles, retiredRoles)` used at startup. Violations:
  - every audited role: `ROLEATTR` `true` for `rolsuper` / `rolbypassrls` / `rolreplication` /
    `rolcreatedb` / `rolcreaterole`, and any `MEMBER` key with the role as member (S9 — these are
    never legitimate for any audited role, so they must not be recordable by `--write`);
  - any `PUBLIC:` TABLE key (S11 — the committed manifest has none);
  - retired roles additionally: `ROLEATTR rolcanlogin true`; `MEMBER` with the role as granted
    role; a `DEFAULTACL` whose ACL item's grantee is the role; any `COLUMN` key (no PUBLIC column
    counterpart is collected); `TABLE` / `SEQUENCE` / `SCHEMA` / `DATABASE` / `FUNCTION` keys that
    PUBLIC does not also hold (counterpart `PUBLIC:<obj>\t<priv>` for TABLE, `<KIND>:public\t…`
    otherwise, `SECURITY_DEFINER` suffix included).
- The MEMBER query also collects rows whose granted role is retired (`OR g.rolname = ANY(<retired>)`),
  and the key gains the option bits: `MEMBER:<member>\t<granted>\tadmin=<t|f>,inherit=<t|f>,set=<t|f>`
  (the committed manifest has no MEMBER keys, so the format change costs nothing). The predicate,
  not the SQL, decides: any key whose member is an audited role is a violation; a key whose granted
  role is retired is a violation unless `inherit=f,set=f`. That ADMIN-only row is what PG16 gives a
  creating CREATEROLE role (on RDS: the master's row into the DCR role, absent on dev/CI where a
  superuser created it); it confers none of the role's privileges, and counting it would fail
  every RDS audit (F-R3-1/R3-S1). The MEMBER parse is strict and fail-closed (R5-S1 — role names
  may contain a tab): exactly three tab-separated fields after `MEMBER:`, the third matching
  `^admin=[tf],inherit=[tf],set=[tf]$`; any MEMBER key that does not parse is a violation, and the
  exemption applies only on an exact `inherit=f,set=f`. Unit rows over keys with each flag
  combination, a malformed key, and a member name containing a tab. The key-form descriptions are
  updated with it: the doc comment and the `writeManifest` `_comment` in `audit-db-grants.mjs`, and
  the key table in `docs/operations/deployment.md` (F-R5-1).
- `readLiveGrants(client)` (already exported) is what the C2 creator case and the C3 integration
  cases feed to the predicate.
- Wiring: live keys → `ROLE_STATE_VIOLATION`; manifest keys → `ROLE_STATE_IN_MANIFEST`; the
  `--write` branch refuses on the live violation and writes nothing (same shape as
  `DENIED_SETTING_HELD`).
- `scripts/checks/app-role-denied-privileges.json` gains entries for both roles on
  `tenant_claim_events`, its sequence and `tenant_claims` (the containment test in
  `app-role-denied-privileges.integration.test.ts` iterates `AUDITED_ROLES`); neither role touches
  claim routing.
- Control class: fail-closed verification gate on the ECS migrate task only. Docker/self-hosted
  deployments do not run the audit (compose `migrate` runs `prisma migrate deploy` alone); there
  C2 is the control and re-enablement is not detected.
- Acceptance:
  - unit (DB-free), table-driven over the predicate: each key kind denied (retired and live-role
    rows, the five elevated attributes, `PUBLIC:` TABLE), each paired with an allow (PUBLIC-held
    SCHEMA USAGE, DATABASE TEMP, FUNCTION; `rolcanlogin true` on a live role; the at-rest key set);
    `assertRetiredSubset` with a subset and a non-subset input;
  - unit over the committed manifest: no violations, and `ROLEATTR:passwd_anchor_publisher\t
    rolcanlogin\ttrue` present;
  - the containment test's anti-vacuity floor in app-role-denied-privileges.integration.test.ts
    names the two new roles;
  - integration, each asserting its own label: LOGIN re-enabled (no password set) →
    `ROLE_STATE_VIOLATION`; `GRANT EXECUTE ON FUNCTION rls_bypass_enforced()` →
    `ROLE_STATE_VIOLATION`; a probe role granted the retired role (default INHERIT/SET, probe
    created and dropped in a `finally` registered at creation) → `ROLE_STATE_VIOLATION` naming its
    MEMBER key (the creator case in C2 is the adjacent allow); a manifest carrying a violation →
    `ROLE_STATE_IN_MANIFEST`; `--write`
    against a re-enabled role → exit 1, label printed, manifest unchanged; at rest → `--write` OK.
    Every mutation of the real role is undone in a `finally` registered at acquisition. Red proof
    against the intermediate state (roles added to `AUDITED_ROLES`, predicate stubbed to `[]`), one
    deny case at a time.

### C4 — no path re-enables the DCR role

- `infra/postgres/initdb/03-create-dcr-cleanup-worker-role.sql`: create the role `NOLOGIN`, no
  password, no grants (kept so a restore of a pre-C2 dump finds the grantee; the restore then
  carries its old grants, and `prisma migrate deploy` after it runs C2).
- `ci-integration.yml`: remove the DCR `ALTER ROLE … LOGIN PASSWORD` line and
  `PASSWD_DCR_CLEANUP_WORKER_PASSWORD`.
- `docs/operations/dev-host-migration.md`: drop the DCR `GRANT CONNECT`; state that a restored
  pre-C2 dump is retired by the post-restore `migrate deploy`.
- The C2 kept test and C3 are the enforcement; a text grep is not a gate (role-name spellings,
  `ALTER USER`, `format(… %I …)` loops). Reviewers check the diff for the role name with
  `LOGIN|PASSWORD|GRANT`.

### C5 — docs, operator procedure, env surface

- `infra/terraform/README.md` (bootstrap block + secrets table), `docs/operations/deployment.md`
  (role table, ownership table, "all three roles", upgrade procedure), `docs/setup/aws/en.md`
  (env list), `scripts/bootstrap-rds-roles.mjs` header, `docs/security/tenant-boundary-matrix.md`
  (anchor publisher: LOGIN, converged and audited; DCR: retired),
  `scripts/set-audit-anchor-publisher-password.sh` (bootstrap sets it on RDS),
  `docs/security/owasp-top10-2026-05.md` (dated snapshot; leave the text, add a pointer if it
  reads as current guidance).
- Password custody: generate (`openssl rand -hex 32`), build `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`
  from it, and add that key to the app secret by read-merge-write (`get-secret-value` piped into
  `jq` → `scripts/put-terraform-secrets.sh` with the merged file; `put-secret-value` replaces the
  whole object). The merged file holds every app secret in plaintext: write it under `umask 077`
  to a `mktemp` path outside the repository, remove it with `trap … EXIT`, and never open it in an
  editor or terminal that keeps history. No task consumes the new key until SC1.
- Upgrade procedure for an existing RDS deployment, written to fit `scripts/deploy.sh` (which
  registers the new task definitions and runs the migrate task in one go, exiting before the
  service-update rollback traps are armed when the migrate task fails):
  1. Run `deploy.sh`. Its migrate task applies C2 and fails the audit; old services keep serving
     (C2 is compatible with the old image — nothing uses the DCR role).
  2. Read the migrate task's CloudWatch log. Proceed only if the audit findings are exactly the
     anchor publisher's `rolcanlogin` pair (`MISSING_GRANT … true`, `UNEXPECTED_GRANT … false`);
     anything else is a stop.
  3. ECS Exec into the now-registered migrate task definition and run the new bootstrap with the
     four passwords.
  4. Re-run `deploy.sh` (`migrate deploy` is a no-op; the audit passes).
- Prior-exposure step (S10): the old `convergeRole` sent `ALTER ROLE … NOSUPERUSER … PASSWORD
  '<cleartext>'`, which RDS refuses with 42501 on every existing role and logs in full under the
  default `log_min_error_statement`. For any RDS deployment where bootstrap ever ran, either confirm
  the RDS PostgreSQL logs from those runs have expired and were never downloaded or exported, or
  rotate those roles' passwords during step 3 (new values in the `*_DATABASE_URL` secrets first).
  Rotating cuts the running old tasks off from NEW connections (their environment holds the old
  password) until step 4 replaces them; run step 3 immediately before step 4 and accept that
  brief window.
- Dev: converge the anchor publisher with
  `ALTER ROLE passwd_anchor_publisher WITH LOGIN PASSWORD '<PASSWD_ANCHOR_PUBLISHER_PASSWORD or the
  initdb fallback>'`, documented for volumes created before initdb 02 gained the role.
- `PASSWD_ANCHOR_PUBLISHER_PASSWORD`: decide `.env.example` / `env-allowlist.ts` / compose `db`
  env by matching `PASSWD_RETENTION_GC_WORKER_PASSWORD`; run `npm run check:env-docs`.

### C6 — existing tests realigned

- `revoke-public-connect.integration.test.ts`: the CONNECT-retained set is the four login roles
  (adds retention GC, which it missed); the DCR role moves to a negative case.

## Testing strategy

Red-first per contract as listed in each Acceptance. Then `npm run test:integration` (workers
stopped), `npx vitest run`, `npx next build`, `scripts/pre-pr.sh`. Dev DB: `npm run db:migrate`,
converge the anchor publisher, `audit-db-grants.mjs --write`, hand-review the manifest diff, rerun
without `--write`.

## Considerations & constraints

- Upgrade hazard: the first deploy of this release on an existing RDS stops at the audit by design;
  C5 is the procedure. Fresh RDS: bootstrap creates the anchor publisher LOGIN; migrations then
  find it existing.
- The anchor publisher becomes LOGIN on RDS before any AWS task uses it (SC1). Accepted by the user;
  mitigated by a generated password held only in Secrets Manager.

### Scope contract

- SC1 — No AWS ECS task runs the anchor publisher (no npm script, no dist bundle, no task
  definition) although production env validation requires `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`.
  New issue.
- SC2 — Revoking PUBLIC's default EXECUTE on functions / USAGE on schema `public`: separate hardening.
- SC3 — DROP ROLE for the DCR role: rejected by the user.
- SC4 — `jackson_user` (jackson DB) stays outside the app DB audit.
- SC5 — `#933` / `#936` are separate issues.
- SC6 — Bootstrap sends cleartext `PASSWORD` DDL, which RDS logs if the statement errors
  (`log_min_error_statement`). C1 removes the deterministic trigger (the full-attribute ALTER) and
  the preflight (elevated attributes, ADMIN OPTION) removes the known remaining ones; past
  exposure is handled in C5.
  The general mitigation (session `SET` of superuser-only logging GUCs, or sending a SCRAM
  verifier) cannot be verified on RDS here (E1). New issue.

## User operation scenarios

- Fresh docker dev volume: initdb creates the DCR role NOLOGIN → migrations grant, then C2 retires.
- Existing dev DB: `npm run db:migrate` retires the role; converge the anchor publisher (C5).
- RDS upgrade: the C5 procedure.
- Fresh RDS: bootstrap → migrations → audit OK.
- Restore of a pre-C2 dump onto a fresh host: initdb 03 provides the grantee, restore succeeds,
  post-restore `migrate deploy` retires it.

## Go/No-Go Gate

| ID | Subject                                                         | Status  |
|----|-----------------------------------------------------------------|---------|
| C1 | convergeRole RDS-safe; anchor publisher converged               | locked  |
| C2 | migration retires passwd_dcr_cleanup_worker                     | locked  |
| C3 | audit covers both roles; retired state prescriptive incl. write | locked  |
| C4 | no path re-enables the DCR role                                 | locked  |
| C5 | docs, operator procedure, env surface                           | locked  |
| C6 | existing tests realigned                                        | locked  |
