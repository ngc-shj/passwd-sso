# Plan Review: rds-roles-anchor-publisher-dcr-worker
Date: 2026-10-23
Review round: 1

## Changes from Previous Round

Initial review. Local LLM pre-screen raised one Minor (retired-role check must also cover the
elevated attributes), applied before the experts ran.

## Merged findings and disposition

Convergence: PUBLIC's USAGE on schema `public` was raised independently by all three experts
(T-1 Critical, F3 Major, S2 Major) — merged as M1, Critical floor. The RDS-master limitation was
raised by Functionality (F1, F2 Critical) and Security (A2) — merged as M2. Absence handling (T-4,
F11, S5), `--write` refusal (T-3, F5, S3), default ACL / ownership (F6, S4) and forbidden-pattern
spelling (T-12, S8) likewise merged. Claims verified by the orchestrator before acting: M1
(`has_schema_privilege('passwd_dcr_cleanup_worker','public','USAGE')` = t on dev; manifest line
`SCHEMA:public\tpublic\tUSAGE`), M2 (`docs/setup/aws/en.md` "RDS master users are not SUPERUSER",
plus a local probe recorded in the plan under E1), absence (`has_table_privilege` on an unknown role
raises `role … does not exist`), A1 (restore runbook uses `--exit-on-error` on an initdb-only
cluster).

| ID | Sources | Sev | Kind | Disposition |
|----|---------|-----|------|-------------|
| M1 | T-1, F3, S2 | Critical | design | Fixed — C2 acceptance and C3 predicate use the PUBLIC baseline for every key kind |
| M2 | F1, F2, A2 | Critical | design | Fixed — C1 makes `convergeRole` RDS-safe (user chose full scope); C2 has no SUPERUSER/BYPASSRLS/REPLICATION clause; C5 upgrade procedure fits deploy.sh |
| S1 | Security | Major | design | Fixed — user accepted LOGIN on RDS; C5 password custody in Secrets Manager |
| F4 | Functionality | Major | design | Fixed — C3 adds denied-policy entries for both roles |
| T-2 | Testing | Major | design | Fixed — C3 tests assert their own labels; red proof against the intermediate state |
| T-3/F5/S3 | all | Major | design | Fixed — `--write` refuses on `RETIRED_ROLE_ACTIVE` |
| T-4/F11/S5 | all | Major | design | Fixed — audit requires roles to exist (stated); `RETIRED_ROLES ⊆ AUDITED_ROLES` guard; no absence test on the real role |
| T-5 | Testing | Major | design | Fixed — exported `grantWorkerSchemaPrivileges`, recorder test, ROLES/AUDITED_ROLES equality |
| T-6 | Testing | Major | design | Fixed — table-driven predicate test per key kind with allow pairs; EXECUTE deny case |
| T-7 | Testing | Major | design | Fixed — kept in-transaction migration test + absent-role guard case |
| T-8 | Testing | Major | design | Fixed — DB-free test of the committed manifest |
| F6/S4 | Func, Sec | Minor | design | Fixed — default ACLs per owner, ownership refusal, both membership directions |
| F7 | Functionality | Minor | prose | Fixed — `pg_authid` |
| F8 | Functionality | Minor | prose | Fixed — C5 file list |
| F9 | Functionality | Minor | design | Fixed — single BEGIN/COMMIT |
| F10 | Functionality | Minor | design | Fixed — dev convergence command in C5 |
| T-9 | Testing | Minor | design | Fixed — `finally` restore, no password on re-enable |
| T-10 | Testing | Minor | prose | Fixed — C6 |
| T-11 | Testing | Minor | design | Fixed — C1 missing-password test |
| T-12/S8 | Test, Sec | Minor | design | Fixed — C4 states the patterns are review aids; C2 test + C3 are the gate |
| S6 | Security | Minor | prose | Fixed — C3 control class narrowed to the ECS migrate task |
| S7 | Security | Minor | design | Out of scope — SC6 (see Anti-Deferral below) |
| A1 | Security | Minor | design | Fixed — initdb 03 kept, creates the role NOLOGIN |

### Anti-Deferral: S7 (SC6)

- Finding: bootstrap sends cleartext `PASSWORD` DDL that RDS logs on error.
- Why not here: pre-existing for every role; both candidate mitigations depend on RDS behaviour
  that E1 prevents verifying (whether the master may `SET` superuser-only logging GUCs; generating a
  SCRAM verifier client-side would be new crypto code). Shipping an unverified mitigation would be
  a claim stronger than the implementation (R49).
- Cost of deferral: the exposure exists today for three roles and gains a fourth; it requires a
  failing bootstrap statement AND log access.
- Owner: a new issue filed with this PR.

## Recurring Issue Check

### Functionality expert
R1 Checked (reuses the DENIED two-sided shape); R2 Checked (lists derived from ROLES); R3 Checked —
F8; R4 N/A; R5 Checked — F9; R6–R13 N/A; R14 Checked — F6; R15 Checked (current_database()); R16
Checked — F1, F10; R17 N/A; R18 Checked — F8 env-allowlist; R19–R21 N/A; R22 Checked — F2; R23 N/A;
R24 Checked OK; R25–R28 N/A; R29 Checked — commands reproduce (7 URL vars, 6 CREATE ROLE names);
F3, F7, F11; R30 N/A; R31 Checked OK (no DROP); R32 N/A; R33 Checked OK; R34 Checked — F2; R35
Checked — F1/F2 are the RDS-only behaviour; R36–R37 N/A; R38 Checked — P3009 wedge (F1); R39–R40
N/A; R41 Checked — F1, F2; R42 Checked — F4, F8; R43 N/A; R44 Checked (`set -e` in ecs.tf); R45–R47
N/A; R48 Checked — F3; R49 Checked — F5; R50 Checked — F1; R51 N/A; R52 Checked — F4; R53–R57 N/A.

### Security expert
R1 OK; R2 OK; R3 Finding S3; R4 N/A; R5 OK; R6–R13 N/A; R14 Finding S1 (anchor publisher table
grants match its code); R15 OK; R16 Checked (manifest must be LOGIN everywhere); R17 N/A; R18 N/A;
R19–R28 N/A; R29 Finding S2 (C1 member-set commands reproduce); R30 N/A; R31 OK; R32 N/A; R33 OK;
R34 S7 reported; R35 OK; R36–R40 N/A; R41 related S1; R42 Findings S4, A1 (member sets re-derived,
match); R43 Finding S1; R44 OK; R45–R47 N/A except R47 Finding S8; R48 OK; R49 Findings S5, S6; R50
related S2, A2; R51 N/A; R52 Checked; R53 N/A; R54 OK (live check independent of
`DB_GRANTS_MANIFEST`); R55–R57 N/A. RS1 N/A; RS2 N/A; RS3 OK (hardcoded role names, escapeLiteral);
RS4 OK; RS5 N/A; RS6 OK.

### Testing expert
R1 N/A; R2 Checked — T-5; R3 Checked — T-1; R4–R13 N/A; R14 Checked — T-1 adjacent; R15 Checked;
R16 Checked — T-7; R17–R28 N/A; R29 Finding — T-1, T-4 (member-set greps reproduce); R30–R41 N/A;
R42 Checked — T-5, T-10; R43–R46 N/A; R47 Adjacent T-12; R48 N/A; R49 Checked; R50 Checked — T-8;
R51–R57 N/A. RS1–RS6 out of scope. RT1 Checked (real DB); RT2 Checked — T-4; RT3 N/A; RT4 N/A; RT5
Finding — T-5, T-7; RT6 Checked — T-5, T-6; RT7 Finding — T-2, T-8; RT8 Finding — T-2, T-5; RT9 N/A;
RT10 Finding — T-3, T-6, T-11; RT11 Finding — T-9 (and the DROP hazard in T-4).

---

# Round 2
Date: 2026-10-23

## Changes from Previous Round

Revision 2 applied every round-1 finding; the user chose full scope (RDS-safe `convergeRole`,
anchor publisher LOGIN with Secrets Manager custody). All round-1 fixes were confirmed by their
filing experts.

## Merged findings and disposition

Verified by the orchestrator before acting: PG16 `REVOKE <role> FROM <member>` by a non-superuser
lacking ADMIN on the granted role raises 42501 ("Only roles with the ADMIN option … may revoke");
`pg_has_role(current_user, r, 'MEMBER WITH ADMIN OPTION')` is true for a role the CREATEROLE caller
created and false for one it did not (both probes in `BEGIN … ROLLBACK` on the dev DB).

| ID | Sources | Sev | Kind | Disposition |
|----|---------|-----|------|-------------|
| R2-1 | N-1, F-R2-2 | Critical | design | Fixed — C2 kept test runs the extracted body; absent case by RENAME; residue check |
| R2-2 | F-R2-1, N-3 | Major | design | Fixed — `GRANTED BY <grantor>` + post-check throw in C1 and C2; stand-in membership case |
| R2-3 | N-2 | Major | design | Fixed — stand-in cases in rolled-back transactions, target created by the stand-in, messages asserted |
| R2-4 | N-4 | Major | design | Fixed — explicit empty env, stderr asserts |
| R2-5 | S9 | Major | design | Fixed — `roleStateViolations` covers elevated attributes and memberships of every audited role, incl. `--write` |
| R2-6 | S10 | Major | design | Fixed — C5 prior-exposure step; SC6 reasoning corrected; user informed directly |
| R2-7 | A3 | Minor | design | Fixed — ADMIN-OPTION preflight before any password DDL; C2 precondition stated |
| R2-8 | S11 | Minor | design | Fixed — `PUBLIC:` TABLE keys are violations |
| R2-9 | S12, F-R2-4 | Minor | design/prose | Fixed — MEMBER query also collects members of retired roles; COLUMN rule stated |
| R2-10 | S13 | Minor | design | Fixed — operator checks the exact findings before step 3 |
| R2-11 | S14 | Minor | prose | Fixed — C1 control class split |
| R2-12 | F-R2-3 | Minor | design | Fixed — RAISE naming the owner when not a member |
| R2-13 | F-R2-5 | Minor | prose | Fixed — read-merge-write custody |
| R2-14 | N-5, N-6, N-7 | Minor | design | Fixed — owned-object case, subset-guard unit test, anti-vacuity floor, exports stated |

## Recurring Issue Check

### Functionality expert
R1 Checked; R2 Checked (ROLES/AUDITED_ROLES equality); R3 Checked — F-R2-1; R4 N/A; R5 Checked —
F-R2-2; R6–R13 N/A; R14 Checked — F-R2-3; R15 Checked; R16 Checked — F-R2-1, F-R2-3; R17 N/A; R18
Checked (check:env-docs); R19–R21 N/A; R22 Checked — F-R2-1; R23 N/A; R24 Checked; R25–R28 N/A; R29
Checked — commands reproduce, deploy.sh exit/trap claims verified; F-R2-4; R30 N/A; R31 Checked —
F-R2-2; R32 N/A; R33 Checked; R34 Checked (fixed in scope); R35 Checked; R36–R37 N/A; R38 Checked —
F-R2-1, F-R2-3; R39–R40 N/A; R41 Checked — F-R2-1, F-R2-5; R42 Checked; R43 N/A; R44 Checked; R45–R47
N/A; R48 Checked — F-R2-4; R49 Checked — F-R2-1; R50 Checked; R51 N/A; R52 Checked; R53–R57 N/A.

### Security expert
R1 OK; R2 OK; R3 Finding S9; R4 N/A; R5 OK; R6–R13 N/A; R14 OK; R15 OK; R16 OK; R17–R28 N/A; R29
Finding S10; R30 N/A; R31 OK; R32 N/A; R33 OK; R34 Finding S10; R35 OK; R36–R40 N/A; R41 OK; R42
Finding S12 (member sets re-derived, match); R43 OK; R44 Finding S13; R45–R46 N/A; R47 OK; R48 OK;
R49 Findings S9, S14; R50 related S13, A3; R51 N/A; R52 OK; R53 N/A; R54 OK; R55–R57 N/A. RS1 N/A;
RS2 N/A; RS3 OK; RS4 OK; RS5 N/A; RS6 OK.

### Testing expert
R1 N/A; R2 Checked; R3 Checked; R4–R13 N/A; R14 Checked — adjacent N-3; R15 Checked; R16 Checked —
N-4; R17–R28 N/A; R29 Checked — N-2(a) precondition; R30–R41 N/A; R42 Finding N-7; R43–R46 N/A; R47
Checked; R48 N/A; R49 Checked; R50 Checked; R51–R57 N/A. RS1–RS6 out of scope. RT1 Finding N-4; RT2
Checked; RT3 N/A; RT4 N/A; RT5 Finding N-1; RT6 Checked; RT7 Findings N-2, N-6; RT8 Findings N-2(b),
N-4, N-7; RT9 N/A; RT10 Findings N-3, N-5; RT11 Findings N-1, N-2(c).

---

# Round 3
Date: 2026-10-23

## Changes from Previous Round

Revision 3 applied every round-2 finding; all were confirmed by their filing experts. Round 3
findings are all against the revision-3 edits.

## Merged findings and disposition

Verified by the orchestrator: a NOSUPERUSER CREATEROLE role creating a role receives a
`pg_auth_members` row into it with `admin_option = t, inherit_option = f, set_option = f`, grantor
the bootstrap superuser (dev DB probe in `BEGIN … ROLLBACK`). `analyze(sql)` is exported by
`scripts/checks/check-migration-transaction.mjs` and returns `beginCount` / `commitCount` /
`rollbackCount`.

| ID | Sources | Sev | Kind | Disposition |
|----|---------|-----|------|-------------|
| R3-1 | F-R3-1, R3-S1 | Critical | design | Fixed — only `inherit_option OR set_option` member rows into a retired role count (C2 revoke + post-check + acceptance, C3 query); creator kept-test case and unit rows |
| R3-2 | R3-1 (testing) | Major | design | Fixed — preflight keys on `current_user` |
| R3-3 | R3-S2 | Minor | design | Fixed — preflight throws on elevated target attributes before the password DDL |
| R3-4 | R3-2 (testing) | Minor | design | Fixed — recorder delegates `escapeLiteral`, positive control asserted |
| R3-5 | R3-3 (testing) | Minor | design | Fixed — membership cases pinned to the PG16 outcome |
| R3-6 | R3-4 (testing) | Minor | design | Fixed — body extraction gated on the gate's own `analyze()` |
| R3-7 | R3-S3 | Minor | design | Fixed — merged secret file handling |
| R3-8 | R3-A1 | Minor | design | Fixed — rotation window stated |

## Recurring Issue Check

### Functionality expert
R1–R2 Checked; R3 Checked — F-R3-1 is the C2/C3 half of the GRANTED BY pattern; R4 N/A; R5 Checked;
R6–R13 N/A; R14 Checked — F-R3-1; R15 Checked; R16 Checked — F-R3-1; R17 N/A; R18 Checked; R19–R21
N/A; R22 Checked (preflight vs creator grant); R23 N/A; R24 Checked; R25–R28 N/A; R29 Checked —
manifest claims reproduced (0 MEMBER, 0 PUBLIC, 0 elevated ROLEATTR); R30 N/A; R31 Checked; R32 N/A;
R33–R35 Checked; R36–R37 N/A; R38 Checked — F-R3-1; R39–R40 N/A; R41 Checked — F-R3-1; R42 Checked;
R43–R47 N/A; R48 Checked — F-R3-1; R49–R50 Checked; R51 N/A; R52 Checked — F-R3-1; R53–R57 N/A.

### Security expert
R1–R3 OK; R4 N/A; R5 OK; R6–R13 N/A; R14–R15 OK; R16 Finding R3-S1; R17–R28 N/A; R29 related R3-S2;
R30 N/A; R31 OK; R32 N/A; R33–R35 OK; R36–R40 N/A; R41 OK; R42 Finding R3-S1; R43–R44 OK; R45–R47
N/A; R48–R49 OK; R50 Finding R3-S1; R51 N/A; R52 Checked; R53 N/A; R54 OK; R55–R57 N/A. RS1–RS2 N/A;
RS3 OK; RS4 related R3-S3; RS5 N/A; RS6 OK.

### Testing expert
R1 Checked; R2–R13 N/A; R14–R16 Checked (R16: R3-1); R17–R28 N/A; R29 Checked; R30–R41 N/A; R42
Checked; R43–R47 N/A; R48 Finding R3-1, R3-4; R49–R50 Checked; R51–R57 N/A. RS1–RS6 out of scope.
RT1–RT2 Checked; RT3–RT4 N/A; RT5–RT6 Checked; RT7 Finding R3-1; RT8 Findings R3-2, R3-3; RT9 N/A;
RT10–RT11 Checked.

---

# Round 4
Date: 2026-10-23

## Changes from Previous Round

Revision 4 applied every round-3 finding; all were confirmed by their filing experts (Security
answered that ADMIN-only rows into the retired role are not a fail-open: every use of that
capability changes state the audit reads).

## Merged findings and disposition

| ID | Sources | Sev | Kind | Disposition |
|----|---------|-----|------|-------------|
| R4-1 | F-R4-1, R4-1 (testing) | Major | design | Fixed — superuser path keeps the full `ROLE_ATTRS` ALTER (T3 unchanged); preflight throw only for a non-superuser `current_user`; stand-in throw case per elevated attribute |
| R4-2 | R4-2 (testing) | Major | design | Fixed — MEMBER key carries the option bits; the predicate decides; probe-member integration deny case; creator case is the allow |
| R4-3 | R4-3 (testing) | Minor | design | Fixed — creator-row precondition asserted before and after; body runs as superuser; RDS identity E1-deferred |
| R4-4 | R4-S1 | Minor | design | Skipped — see Anti-Deferral |

### Anti-Deferral: R4-S1

- Finding: the ADMIN-only exemption applies to any member, not only the creating CREATEROLE role.
- Why skipped: narrowing it needs the member's `rolsuper`/`rolcreaterole` in the key or a second
  query over non-audited roles. The Security expert's own analysis (round 4) shows every use of an
  ADMIN-only grant — granting the role on with INHERIT/SET, re-enabling LOGIN, granting it
  privileges — produces a key the predicate already denies; the grant itself confers nothing.
- Cost of skipping: a dormant, out-of-band ADMIN grant on a NOLOGIN, privilege-less role stays
  unreported until used. Marked optional by its filer.
- Owner: none; revisit if a retired role ever keeps privileges.

## Recurring Issue Check

### Functionality expert
R1–R3 Checked; R4 N/A; R5 Checked (analyze() gate); R6–R13 N/A; R14–R15 Checked; R16 Checked —
F-R4-1; R17 N/A; R18 Checked; R19–R21 N/A; R22 Checked — F-R4-1; R23 N/A; R24 Checked; R25–R28 N/A;
R29 Checked — F-R4-1; R30 N/A; R31 Checked; R32 N/A; R33–R35 Checked; R36–R37 N/A; R38 Checked;
R39–R40 N/A; R41–R42 Checked; R43 N/A; R44 Checked; R45–R47 N/A; R48 Checked; R49 Checked — F-R4-1;
R50 Checked; R51 N/A; R52 Checked — F-R4-1; R53–R57 N/A.

### Security expert
R1–R3 OK; R4 N/A; R5 OK; R6–R13 N/A; R14–R16 OK; R17–R28 N/A; R29 OK; R30 N/A; R31 OK; R32 N/A;
R33–R35 OK; R36–R40 N/A; R41 OK; R42 Finding R4-S1 (optional); R43–R44 OK; R45–R47 N/A; R48–R50 OK;
R51 N/A; R52 OK; R53 N/A; R54 OK; R55–R57 N/A. RS1–RS2 N/A; RS3–RS4 OK; RS5 N/A; RS6 OK.

### Testing expert
R1–R13 N/A; R14 Checked — R4-2; R15 Checked; R16 Checked — R4-3; R17–R28 N/A; R29 Finding R4-1;
R30–R41 N/A; R42 Checked; R43–R47 N/A; R48 Checked; R49–R57 N/A. RS1–RS6 out of scope. RT1–RT2
Checked; RT3–RT4 N/A; RT5 Finding R4-2; RT6 Checked; RT7 Finding R4-1; RT8 Findings R4-2, R4-3; RT9
N/A; RT10 Finding R4-2; RT11 Checked.

---

# Round 5
Date: 2026-10-23

## Changes from Previous Round

Revision 5 applied every round-4 finding (R4-S1 skipped with an Anti-Deferral the Security expert
agreed with). No Critical or Major this round; three Minors, all against the revision-5 edits.

| ID | Sources | Sev | Kind | Disposition |
|----|---------|-----|------|-------------|
| R5-1 | R5-S1 | Minor | design | Fixed — strict, fail-closed MEMBER parse; malformed and tab-in-name unit rows |
| R5-2 | F-R5-1 | Minor | prose | Fixed — key-form descriptions listed (doc comment, `writeManifest` `_comment`, deployment.md) |
| R5-3 | R5-1 (testing) | Minor | design | Fixed — creator case positive control on the ADMIN-only key; violations restricted to the retired role |

## Recurring Issue Check

### Functionality expert
R1–R3 Checked (R3: F-R5-1); R4 N/A; R5 Checked; R6–R13 N/A; R14–R16 Checked (all engines PG16);
R17 N/A; R18 Checked; R19–R21 N/A; R22 Checked (T3 demotion preserved); R23 N/A; R24 Checked;
R25–R28 N/A; R29 Checked; R30 N/A; R31 Checked; R32 N/A; R33–R35 Checked; R36–R37 N/A; R38 Checked;
R39 N/A; R40 Checked (one strict MEMBER consumer, still a prefix match); R41 N/A; R42 Checked;
R43 N/A; R44 Checked; R45–R47 N/A; R48–R50 Checked; R51 N/A; R52 Checked; R53–R57 N/A.

### Security expert
R1–R3 OK; R4 N/A; R5 OK; R6–R13 N/A; R14–R16 OK; R17–R28 N/A; R29 OK; R30 N/A; R31 OK; R32 N/A;
R33 OK; R34 OK (R4-S1 Anti-Deferral agreed); R35 OK; R36–R40 N/A; R41–R44 OK; R45–R46 N/A; R47
Finding R5-S1; R48–R50 OK; R51 N/A; R52 OK; R53 N/A; R54 OK; R55–R57 N/A. RS1–RS2 N/A; RS3 related
R5-S1; RS4 OK; RS5 N/A; RS6 OK.

### Testing expert
R1–R13 N/A; R14–R16 Checked; R17–R28 N/A; R29 Checked; R30–R41 N/A; R42 Checked; R43–R47 N/A; R48
Checked; R49–R57 N/A. RS1–RS6 out of scope. RT1–RT2 Checked; RT3–RT4 N/A; RT5–RT7 Checked; RT8
Finding R5-1; RT9 N/A; RT10–RT11 Checked.

---

# Round 6
Date: 2026-10-23

## Changes from Previous Round

Revision 6 applied the three round-5 Minors (strict fail-closed MEMBER parse, key-form description
sites, creator-case positive control). All three experts returned **No findings**; every contract
is locked (plan Go/No-Go Gate). Phase 1 complete after 6 rounds.

## Recurring Issue Check

### Functionality expert
No findings. R3 Checked (F-R5-1 sites listed); R29 Checked (producer/reader sites verified); R35
Checked (RDS master identity E1-deferred); R40 Checked (key shape and strict consumer aligned); R47
Checked (exact flag match); R48 Checked (single adjudicator); R50 Checked (positive control); all
other rules N/A or Checked as in round 5.

### Security expert
No findings. R47 OK (R5-S1 applied); R50 OK (creator case positive control); all other rules OK or
N/A as in round 5. RS3 OK; RS4 OK.

### Testing expert
No findings. R29 Checked (`grep -cF '"MEMBER:'` → 0 in the committed manifest); R48 Checked; RT5,
RT7, RT8, RT10, RT11 Checked; all other rules N/A or Checked as in round 5.
