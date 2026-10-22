# Code Review: rds-roles-anchor-publisher-dcr-worker
Date: 2026-10-23
Review round: 2

## Changes from Previous Round

Initial review. Reviewers were fresh agents (not the plan reviewers), base `origin/main`. Local-LLM
pre-screen: no Critical/Major. Seeds: functionality unavailable (full-diff review); security
"No findings"; testing two Minors (one rejected — the anchor publisher CONNECT case exists — one
adopted as T-1).

## Functionality Findings

No new RDS-vs-local divergence of the D5 kind found (audit keys, migration and bootstrap statements
checked against a NOSUPERUSER CREATEROLE CREATEDB master named `passwd_user` that created the roles
and owns the tables).

- F1 [Minor] Per-role autocommit convergence left earlier roles' passwords changed when a later
  role was refused; the manual-test rollback text omitted it.
- F2 [Minor] Stale "SUPERUSER connection" / "applied on both CREATE and ALTER" comments.
- F3 [Minor] `docs/setup/aws/en.md` listed `PASSWD_ANCHOR_PUBLISHER_PASSWORD` as a stored secret,
  contradicting the README's single-copy custody.
- F4 [Minor] Docs claimed only the creator's ADMIN-only row is allowed; the code allows any
  non-audited ADMIN-only row (D8).

## Security Findings

- S1 [Major] The non-superuser preflight did not check the caller's CREATEROLE/CREATEDB (ALTER path)
  or CREATEROLE (CREATE path); a refused password-bearing statement would be logged; docs overstated
  the guarantee. `escalate: false`.
- S2 [Minor] LOGIN and the new password were committed before the membership strip could fail.
- S3 [Minor] A tab in a DEFAULTACL owner name hid a default ACL naming the retired role.
- S4 [Minor] The migration asserted no object-ACL postcondition; third-party-grantor grants and
  unenumerated object kinds could survive retirement.

## Testing Findings

- T-1 [Major] convergeRole's absent (CREATE) branch was never run as a non-superuser; D1 had no
  failing test.
- T-2 [Minor] The creator-grant exclusion was untested on `--write` and the manifest side.
- T-3 [Minor] The convergeRole re-query guard was reachable via an injected client; D9's reason was
  inaccurate.
- T-4 [Minor] Manual-test M3 claimed the migration body runs as the stand-in.

## Adjacent Findings

None beyond those merged above (F1 and S2 concern the same autocommit loop and share one fix).

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
R1 N/A; R2 checked (cross-file equality test); R3 checked (DCR references updated everywhere);
R4–R13 N/A; R14 checked; R15 checked; R16 checked in depth, no new divergence; R17–R28 N/A; R29
checked (F3, F4); R30–R34 N/A; R35 manual-test present (F1); R36–R41 N/A; R42 checked; R43–R48 N/A;
R49 F4; R50–R57 N/A.

### Security expert
R1 OK; R2 OK; R3 OK; R4 N/A; R5 S2; R6–R13 N/A; R14 OK (S4 for retirement completeness); R15 OK;
R16 OK; R17 OK; R18 OK; R19–R21 N/A; R22 OK; R23 N/A; R24 OK; R25–R28 N/A; R29/R49 S1; R30 N/A; R31
OK; R32 N/A; R33 OK; R34 S4 reported; R35 OK; R36 OK; R37 OK; R38 N/A; R39 S4 (user mappings);
R40 N/A; R41 OK; R42 S1, S4; R43 OK; R44 OK; R45–R46 N/A; R47/R48 S3; R50 OK; R51 S1 TOCTOU
residual; R52 OK; R53 N/A; R54 OK; R55 OK; R56–R57 N/A. RS1–RS3 N/A; RS4 OK; RS5 N/A; RS6 OK.

### Testing expert
R1–R13 N/A; R14 checked; R15 checked; R16 checked; R17–R18 N/A; R19 checked; R20–R28 N/A; R29 T-4,
T-3; R30–R34 N/A; R35 T-4; R36–R41 N/A; R42 checked; R43–R57 N/A (R48 checked). RS* out of scope.
RT1 checked; RT2 checked; RT3 checked; RT4 N/A; RT5 checked; RT6 T-1; RT7 T-1, T-2, T-3; RT8 checked;
RT9 N/A; RT10 T-1; RT11 checked.

## Environment Verification Report

- C1 stand-in paths (convergeRole and convergeRoles as a NOSUPERUSER CREATEROLE CREATEDB role):
  verified-local — `npx vitest run --config vitest.integration.config.ts
  src/__tests__/db-integration/bootstrap-rds-roles.integration.test.ts` (43 passed).
- C2 migration body: verified-local as the superuser against a stand-in-created role
  (`retire-dcr-cleanup-worker.integration.test.ts`, 6 passed); running it under the RDS master's
  own identity: blocked-deferred — plan E1; deviation D9.
- C3 audit: verified-local (`audit-db-grants.integration.test.ts`, 36 passed;
  `scripts/__tests__/audit-db-grants-role-state.test.mjs`, 77 passed).
- C5 RDS upgrade procedure: blocked-deferred — plan E1/E2; manual-test M4.

## Resolution Status

### S1 [Major] Preflight omitted the caller's CREATEROLE/CREATEDB
- Action: `assertCallerCanManageRoles` runs before CREATE (non-superuser) and inside
  `assertConvergeableWithoutSuperuser`; `convergeRoles` runs it once up front. Docs list exactly
  the checked conditions and the unpreflightable residual (SC6).
- Modified: `scripts/bootstrap-rds-roles.mjs` (`assertCallerCanManageRoles`, `convergeRole`),
  `docs/setup/aws/en.md`, `infra/terraform/README.md`.
- Tests: caller with CREATEDB only / CREATEROLE only (ALTER), without CREATEDB (CREATE); red-proven
  by stubbing the check (3 fail).

### T-1 [Major] CREATE branch never run as a non-superuser
- Action: stand-in case converging an absent role (CREATE only, no ALTER) then the existing one
  (narrowed ALTER), creator row preserved; red-proven by re-adding the ALTER after CREATE.
- Modified: `src/__tests__/db-integration/bootstrap-rds-roles.integration.test.ts`.

### S2 / F1 [Minor] Per-role autocommit
- Action: exported `convergeRoles` — one transaction, non-superuser pre-pass over every existing
  role. Red-proven separately: without the pre-pass a password is sent before the later role is
  refused; without the transaction the role keeps LOGIN and the new password after a failed strip.
- Modified: `scripts/bootstrap-rds-roles.mjs`; tests in the same file; manual-test M4 and
  deployment.md rotation bullet (secret restore if the bootstrap fails).

### S3 [Minor] DEFAULTACL parse
- Action: four-field parse, otherwise a violation; unit rows for a tab in the owner and a missing
  field; red-proven by reverting to `.at(-1)`.
- Modified: `scripts/audit-db-grants.mjs` (`roleStateViolations`).

### S4 [Minor] Migration postcondition
- Action: RAISE when any ACL entry (pg_class, pg_attribute, pg_proc, pg_namespace, current
  pg_database, pg_default_acl, pg_type, pg_language, pg_largeobject_metadata, FDWs, foreign
  servers, pg_parameter_acl, pg_tablespace) or user mapping still names the role. Cases for a
  GRANT OPTION chain and a parameter grant; red-proven by removing the RAISE. Dev checksum: D10.
- Modified: `prisma/migrations/20261023010000_retire_dcr_cleanup_worker_role/migration.sql`.

### T-2 [Minor] Creator exclusion on --write and manifest side
- Action: the creator case also runs `--write` and asserts the key is not written; a manifest
  carrying a creator key passes compare. Red-proven per side.

### T-3 [Minor] Re-query guard
- Action: case with a client that drops REVOKEs; D9 bullet corrected. Red-proven.

### T-4, F2, F3, F4 [Minor] Prose
- Action: manual-test M3 reworded; comments updated; aws/en.md bullet says the password is not
  stored separately; tenant-boundary-matrix and deployment.md MEMBER row state the actual
  exemption (any non-audited ADMIN-only row, D8).

---

# Round 2
Date: 2026-10-23

## Changes from Previous Round

All round-1 findings confirmed resolved by their filing experts (S1–S4, F1–F4, T-1–T-4); the
security expert's R43 comparison found no boundary widened by the round-1 fixes.

## Findings

- N1 [Major] (functionality; same root as security S5 [Minor]) — role convergence committed before
  the privilege transaction, so the round-1 docs' "a failed bootstrap changes no role" and its
  "restore AWSPREVIOUS" recovery step were wrong for a failure in the privilege phase. Status: new.
- N2 [Minor] (functionality) — the migration postcondition's catalog reads were never executed as
  a non-superuser. Status: new.
- R2-1 [Minor] (testing) — session-level `SET ROLE` on the shared `su` connection had no
  failure-path reset in the convergeRoles describe. Status: new.
- R2-2 [Minor] (testing) — only 2 of the postcondition's branches were shown able to fire. Status:
  new.

## Recurring Issue Check (round-2 delta)

### Functionality expert
R5 N1; R16 N2 (non-superuser parity); R29 N1; R35 manual-test M4 (N1); R42 checked (postcondition
catalog set complete for PG16); R49 N1; R50 N2; RT10 N1 (recovery path). Other rules unchanged.

### Security expert
R5 S2 resolved, S5 new (docs); R29/R49 S1 resolved, S5 new; R42 complete up to SC6; R43 no
widening; R47/R48 S3 resolved. Other rules unchanged.

### Testing expert
R29 M3 accurate; R35 M3/M4 updated; RT1 OK (drop-REVOKE double at the injected-client boundary);
RT5 OK; RT6 OK; RT7 R2-2; RT8 OK; RT10 OK; RT11 R2-1. Other rules unchanged.

## Resolution Status (round 2)

### N1 / S5 — one transaction for the whole bootstrap
- Action: `runBootstrap` = `convergeRolesInTx` + `applyPrivilegeSequence` in one transaction
  (D11). Docs (deployment.md rotation bullet, README, aws/en.md, manual-test M4) key the recovery
  step on `bootstrap-rds-roles: done`, and name the lost-commit case as the one ambiguity.
- Test: "runBootstrap rolls role convergence back when the privilege sequence fails" — failure
  injected at the first privilege statement, positive control that the role had LOGIN inside the
  transaction, password hash and NOLOGIN unchanged after. Red-proven by splitting it back into two
  transactions.

### N2 — postcondition readable by the RDS master
- Action: test (f) extracts the postcondition from the migration file and runs it as a NOSUPERUSER
  CREATEROLE CREATEDB role: false at rest, true after a superuser's parameter grant. Red-proven by
  pointing the user-mapping branch at the superuser-only `pg_user_mapping`.

### R2-1 — shared-connection role switch
- Action: fixtures created through the stand-in's own connection; an `afterEach` resets `su` and
  asserts it is a superuser again.

### R2-2 — postcondition branches
- Action: (b3) is table-driven over parameter, type, language, large object, FDW, foreign server,
  user mapping, tablespace — each with a precondition that the catalog row names the role. A user
  mapping is an OWNER dependency in `pg_shdepend`, so the ownership guard refuses it first; that row
  expects the ownership message. Red-proven by breaking the type branch alone.
