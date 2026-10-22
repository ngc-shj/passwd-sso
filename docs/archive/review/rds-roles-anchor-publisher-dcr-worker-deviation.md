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

## D6 — Mechanical-check dispositions

- `check-orphaned-checks.sh` reports `scripts/__tests__/audit-db-grants-role-state.test.mjs` as
  having no caller. It is run by `vitest.config.ts`'s include glob
  (`scripts/__tests__/**/*.test.mjs`), which the hook's basename search cannot see; the integration
  test files are likewise run by `vitest.integration.config.ts`'s `src/**/*.integration.test.ts`.
- `check-new-code-untested.sh` lists the new exports; each has tests in this diff
  (`audit-db-grants-role-state.test.mjs`, `bootstrap-rds-roles.integration.test.ts`).
- `check-deployment-artifact.sh` (R35 Tier-1): `rds-roles-anchor-publisher-dcr-worker-manual-test.md`
  added.

## D7 — `PASSWD_ANCHOR_PUBLISHER_PASSWORD` not added to `.env.example` / `env-allowlist.ts` / compose

C5 asked for this to be decided by matching `PASSWD_RETENTION_GC_WORKER_PASSWORD`. Decided against
(self R-check R18): the sibling is forwarded to the compose `db` service as `:?required`, so
adding this one the same way makes `docker compose up` fail for every existing `.env` that lacks
it; forwarding it as optional passes an empty value when unset, which defeats initdb 02's
`\getenv` fallback and leaves the role with no password. The variable is an input only to the RDS
bootstrap, documented where that runs (`infra/terraform/README.md`, `docs/setup/aws/en.md`).
`npm run check:env-docs` passes.

## D8 — Residual of the creator-grant exclusion (Anti-Deferral)

- Finding (self R-check R43, Minor; same class as plan-review R4-S1): since D5 an explicit
  `GRANT passwd_dcr_cleanup_worker TO <non-audited> WITH ADMIN OPTION, INHERIT FALSE, SET FALSE` is
  indistinguishable from PostgreSQL 16's creator grant and appears in no finding; before D5 it
  would have surfaced as `UNEXPECTED_GRANT`.
- Why not narrowed here: telling them apart needs the member's `rolcreaterole`/`rolsuper` carried
  in the key (a new flag, a format and regex change across the audit, docs and tests) for a grant
  that confers none of the role's privileges.
- Cost: a dormant ADMIN grant on a NOLOGIN, privilege-less role goes unreported until used. Every
  use is still a finding: granting the role on with INHERIT/SET (`MEMBER … inherit=t` or `set=t`),
  re-enabling LOGIN (`rolcanlogin true`), or granting it privileges (an object key PUBLIC does not
  hold).
- Owner: none; revisit if a retired role ever keeps privileges, or if a second retired role is
  added.

## D9 — Fail-closed guards left unexercised (self R-check RT7, Minor)

- `migration.sql`: the RAISE when a membership survives the GRANTED BY revokes. PostgreSQL 16's
  `REVOKE … GRANTED BY` either removes the named grantor's row or raises (42501) — the guard is
  the backstop for a version that does neither.
- `migration.sql`: the RAISE when a default ACL naming the role is owned by a role the current user
  is not a member of. Reaching it as a non-superuser needs the body's earlier
  `REVOKE ALL ON ALL TABLES` to succeed as that user, which on PostgreSQL 16 requires holding some
  privilege on every table (RDS: the master owns them; locally the superuser does). Tried as a
  CREATEDB CREATEROLE stand-in: the REVOKE raised `permission denied for table accounts` first.
  Reproducing the master's ownership is out of proportion; the superuser path cannot reach it
  (`pg_has_role` is always true for a superuser). E1.
- ~~`convergeRole`: the throw when the post-revoke re-query still finds a membership.~~ Reachable
  after all (Phase 3 T-3): convergeRole takes an injected client, so a client that drops `REVOKE`
  statements leaves the row in place. Now tested ("throws when a membership is still there after
  the revokes").

All three stop the run rather than letting it pass. Also learned in the attempt: a role without
CREATEDB may not issue `NOCREATEDB` even as a no-op, so convergeRole's narrowed ALTER and the
migration's `ALTER ROLE` assume the RDS master has CREATEDB, which it does; the convergeRole
stand-in tests give the stand-in CREATEDB for that reason.

## D10 — Phase 3 round 1 changes beyond the locked contracts

- **convergeRoles (C1).** `main` now calls an exported `convergeRoles(client, roles)` instead of
  looping `convergeRole`: one transaction for every role, and as a non-superuser every existing
  role is preflighted before the first password-bearing statement (code-review S2, F1). Before,
  each role autocommitted, so a refusal on a later role — or a failed membership strip on the same
  role — left earlier roles with new passwords and a role with LOGIN it should not have had.
- **Caller attributes in the preflight (C1).** The preflight also requires the connection to hold
  CREATEROLE and CREATEDB, on both the CREATE and the ALTER branch (code-review S1); D9 had
  recorded the CREATEDB requirement as an assumption only.
- **DEFAULTACL keys parse fail-closed (C3).** A key that does not split into four fields is a
  violation, as MEMBER keys already were (code-review S3).
- **Migration postcondition (C2).** The retirement migration now RAISEs if any ACL entry or user
  mapping still names the role after the revokes — grants whose grantor is not the object's owner,
  and object kinds the loops do not enumerate (code-review S4). The migration had already been
  applied to the dev database; its `_prisma_migrations.checksum` was updated to the new file's
  SHA-256 in place (no reset), after the new postcondition was dry-run against that database inside
  `BEGIN … ROLLBACK`. `npx prisma migrate status` reports the schema up to date.
