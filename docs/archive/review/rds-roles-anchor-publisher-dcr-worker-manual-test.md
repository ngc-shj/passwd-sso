# Manual test: rds-roles-anchor-publisher-dcr-worker

Deployment artifacts in the diff: `.github/workflows/ci-integration.yml` (role setup step),
`infra/postgres/initdb/03-create-dcr-cleanup-worker-role.sql`, a Prisma migration, and the RDS
bootstrap / grant-audit scripts the ECS migrate task runs. Tier-1.

## M1 — Existing dev database (verifiable-local, executed)

Pre-conditions: dev compose stack up; `passwd_dcr_cleanup_worker` LOGIN with grants (state before
migration 20261023010000); `passwd_anchor_publisher` NOLOGIN.

Steps:
1. `npx prisma migrate deploy`.
2. Converge the anchor publisher with the `docs/operations/deployment.md` "Existing dev volumes"
   commands, verbatim.
3. `MIGRATION_DATABASE_URL=<superuser-url> node scripts/audit-db-grants.mjs`.

Expected: migration applied; `pg_roles.rolcanlogin` false for the DCR role and true for the anchor
publisher; audit prints `db-grants: OK (435 grants match the manifest)` and exits 0.

Observed: as expected (2026-10-23).

Rollback: none needed for dev. The retirement is a forward-only migration; to undo on dev, re-grant
by hand (no application path uses the role).

## M2 — Migration body dry run (verifiable-local, executed)

Steps: run the migration body inside `BEGIN … ROLLBACK` as the superuser and query the role's
`pg_authid` row, every `aclexplode` naming it, and `has_database_privilege(…, 'CONNECT')`.

Expected: NOLOGIN, NULL password, no ACL entry in the current database, no CONNECT.
Observed: as expected; the only remaining entry was CONNECT on `passwd_sso_e2e`, a different
database whose own migration run retires it (deviation D2).

## M3 — RDS-shaped convergence and creator grant (verifiable-local via stand-in, executed)

Covered by integration tests: convergeRole runs as a NOSUPERUSER CREATEROLE CREATEDB stand-in for
the RDS master (both the absent and the present branch); the migration body runs as the superuser
against a role the stand-in created, so the creator grant exists (running the body under the
master's own identity is E1, see D9 and M4); and the audit runs with the creator grant's row shape
present, in compare mode, in `--write`, and on the manifest side.
Red-proven on a scratch copy: the old full-attribute ALTER fails all seven stand-in cases;
`roleStateViolations` stubbed to `[]` fails the five deny cases; removing the creator-grant
exclusion fails the RDS-shaped allow case.

## M4 — RDS upgrade (blocked-deferred, E1/E2)

Pre-conditions: an RDS deployment on a release before this one.

Steps: `docs/operations/deployment.md` "One-time upgrade: anchor publisher converged, DCR role
retired", steps 1–4, plus the prior-exposure step.

Expected: step 1 stops at the audit with exactly the `rolcanlogin` pair for
`passwd_anchor_publisher`; step 4's audit passes.

Rollback: the old services keep serving through steps 1–3 (`deploy.sh` exits before any
`update-service`). The migration only narrows the unused DCR role's privileges and needs no
rollback for the old image. If step 3's bootstrap fails, nothing it did is committed: every role
is preflighted before the first password-bearing statement, and role convergence and the privilege
sequence run in one transaction (`runBootstrap`) — so no role is left with a new password or LOGIN,
including in the rotation path, and `bootstrap-rds-roles: done` is printed only after the commit.

Not executable here: no RDS instance or AWS access in this environment.
