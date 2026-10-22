# Coding Deviation Log: rds-roles-anchor-publisher-dcr-worker

## D1 — convergeRole no longer ALTERs right after CREATE

Before, every run issued `ALTER ROLE … WITH <ROLE_ATTRS> PASSWORD` even for a role it had just
created. The CREATE already carries the same attributes and password, and on RDS that redundant
ALTER is exactly the statement the master is refused (and logs). C1 lists the three branches
(absent / superuser / non-superuser); the absent branch now stops at CREATE.

## D2 — C2 acceptance is scoped to the current database

`pg_database` ACLs are cluster-wide. On the dev cluster the role also holds CONNECT on
`passwd_sso_e2e`, a separate deployment database whose own `prisma migrate deploy` retires it
there. The migration revokes on `current_database()` only (R15), so the acceptance query checks the
current database's row, not every row of `pg_database`.

## D3 — Dev database converged by hand for the manifest regeneration

`passwd_anchor_publisher` on the dev volume was NOLOGIN (the volume predates initdb 02's block).
Converged with `ALTER ROLE … WITH LOGIN PASSWORD :'pw'` under `SET log_statement TO 'none'`, the
initdb fallback password, as C5's dev note documents; then `audit-db-grants.mjs --write` (435
grants) and a compare run (OK). The manifest diff adds only the anchor publisher's
migration-granted privileges, both roles' ROLEATTR rows, and the retired role's PUBLIC-inherited
keys (DATABASE TEMP, SCHEMA public USAGE, default-PUBLIC FUNCTION EXECUTE).

## D4 — Deferred CI parity gaps

`extract-ci-checks.sh` lists three CI gates `scripts/pre-pr.sh` does not run:
`check-state-mutation-centralization.sh`, `check-npm-audit.mjs`, `licenses:check*`. The last two
read dependency manifests, which this change does not touch. The first is run once by hand before
the PR.

## D5 — Creator grants are left out of the manifest comparison (found in Phase 2)

Reported by the docs sub-agent while writing the upgrade procedure, and missed by all six
plan-review rounds: C3 judged the ADMIN-only creator membership correctly in
`roleStateViolations`, but the plain manifest diff still compared it. On RDS the master
(`passwd_user`, `infra/terraform/envs/dev/terraform.tfvars`) created `passwd_dcr_cleanup_worker`,
so the live keys carry `MEMBER:passwd_user\tpasswd_dcr_cleanup_worker\tadmin=t,inherit=f,set=f`;
the committed manifest, generated on dev where a superuser created the role, does not. Every RDS
audit would have reported it as `UNEXPECTED_GRANT`, the upgrade procedure's "exactly the
rolcanlogin pair" check would never hold, and step 4 would never pass.

Fix: exported `creatorGrantKeys` selects ADMIN-only memberships of a non-audited role in a retired
role; `main` removes them from both sides of the manifest comparison and from `--write`, after
`roleStateViolations` has judged the full live set. The key is a property of who created the role,
not of the deployment, so the manifest cannot describe it. Tests: unit rows for
`creatorGrantKeys`, and an integration case that creates the same row shape
(`GRANT … WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`) and expects the audit to pass.
