# Coding Deviation Log: departed-member-db-invariants

## D1 — C4 acceptance: the grants audit on `passwd_sso_wt_1060`

- **Plan:** `audit-db-grants.mjs` exits 0 on `passwd_sso_wt_1060`.
- **Observed:** it exits 1. Every finding is a database-name drift: the manifest records `DATABASE:`
  keys for `passwd_sso`, so the worktree database's own `DATABASE:<role> passwd_sso_wt_1060 …` keys
  read as unexpected and the `passwd_sso` ones as missing. The same holds for two `DEFAULTACL`
  rows and the retired `passwd_dcr_cleanup_worker`'s CONNECT. No `PARAMETER:` key is reported.
- **Disposition:** the acceptance is restated as "no `PARAMETER:` finding, and every other finding
  is a database-name drift present on the base commit". The three red-proof runs exit 1 with their
  `PARAMETER_PRIVILEGE_HELD` key: `SET`, `ALTER SYSTEM` and `ROLE_DEFAULT`. They ran on a scratchpad
  copy with a throwaway role `rp_param_probe`, left nothing in `pg_roles`, `pg_parameter_acl` or
  `pg_db_role_setting`, and never touched `passwd_app`.
- The manifest grants no TRIGGER privilege on any table (grep of `db-grants-manifest.json`).

## D2 — C9 changes an existing accept unit cell

- The route cell "admits on an invitation issued after the departure" asserted the very path C9
  closes. That path is an invitee whose tenant row is still departed, which the guard refuses with
  `activation_departed`.
- It is replaced by two cells:
  - the same fixture is refused with `INVITATION_EXPIRED`, and the invitation commits `EXPIRED`;
  - an invitee who has returned (tenant row active, record older than the invitation) is admitted.

## D3 — rule 8 retirement: harness seeds removed

- The self-test harness seeded seven route/service files that existed only to carry rule 8's
  `grant::` exemptions. They were removed, along with `EXEMPT_ADMISSIONS`: its one admission was the
  accept upsert in a removed seed.
- The rule-1 cell "ignores a role-only update" became the retirement's positive cell. An unchecked
  `teamMember.update({ data: { role: "ADMIN" } })` now exits 0.
- The same fixture exits 1 on the base gate (`git show HEAD:…`, scratchpad copy) with
  `grant::src/lib/team/subject.ts::upd::teamMember.update`.
- Real-tree counts are unchanged except that `grants` is gone. Before: memberWrites 21,
  tenantStateWrites 2, admissions 7, grants 13, departureWriters 3, tenantRowDeletes 2,
  membershipEnds 4, membershipCreations 5.

## D4 — integration suite: adopters, changed cells, environment

- **Runs** (scratchpad `b3/`, each judged by exit code):
  - base: `passwd_sso_wt_1060` copy without the migration, database ACL replicated;
  - post-migration before adoption: 225 failures, which define the adopter set;
  - final.
- **Diff by file and cell:** no cell that passed in base fails in final. The new file adds 133
  cells, which pass 20× in a row with no fixture rows leaked.
- **Environment failures**, identical in base and final:
  - `retire-dcr-cleanup-worker` and `revoke-public-connect` T3 fail, because the worktree database
    grants CONNECT to the retired `passwd_dcr_cleanup_worker`;
  - `audit-db-grants` fails for the same reason, and its cells are skipped;
  - the S3 and KMS files fail with no MinIO (`ANCHOR_TEST_S3_ENDPOINT` unset).
  - CI runs both prerequisites. Not changed here.
- **Adopters**, each refused by the arm named:
  - `departed-member-leaked-authority`: `residueDepart` (`departure_active`), `recreatedDepart`
    (`departure_leftover`), and `seedKey` for ended rows (`key_inactive`);
  - `leftover-team-actor-authority`: the same two seeds, and the readmit helper
    (`activation_departed`);
  - `share-departure`: leftover seeds, `created_at` rewrites, and residue re-admission;
  - `departed-member-operator-scripts`: residue fixtures, `created_at` rewrites, and records over
    active rows;
  - `team-tenant-departure`: `addTeamMember` option, A9 stamp, and the accept-shaped re-admission
    seed;
  - `team-tenant-departure-directory-sync`: A3, and the `departCreatedMembership` precondition;
  - `departed-member-followups`, `team-key-rekey-writers` and `team-rekey-pass`: key rows for ended
    members.
- **The re-admit script runs as an owner-shaped NOSUPERUSER probe role**, not `passwd_app`:
  - it now disables the guard trigger, which needs table ownership;
  - its table-list controls stay meaningful.
- **Cells whose expectation changed (C9):** an invitee whose tenant row is still departed is now
  refused with 410. The cells concerned:
  - team-tenant-departure A2;
  - leaked-authority C4;
  - share-departure C3;
  - team-tenant-departure A3.

  Where the cell's subject was the later adjudication, the pre-guard re-admitted state is seeded
  with `writeRefusedState`. A2/A6 mixed-case and A10 return the user first (SCIM `active=true`), so
  their accept stays a 200. No assertion was weakened.
- **New-file notes for B4:**
  - T1 `ON CONFLICT` on residue refuses with `activation_departed`, because BEFORE INSERT fires on
    the proposed row first. That cell is outside the "grant leftover refusal" row's expected set.
  - Scenario 5's rotation writes key rows only, so the "lock on the grant arm" row cannot redden it.
  - The unknown-label raise needs `ALTER TYPE … ADD VALUE`, so it runs in the scratch batch only.

## D5 — VE4 red-proof matrix and VE3 CI sequence

- **Runner:** `scripts/manual-tests/departed-member-guard-redproof.sh`, with one directory per row
  under `departed-member-guard-redproof/rows/`. It is allowlisted in `check-bypass-rls.mjs`'s
  `FUNCTION_RULE_ALLOWLIST`, because it replaces `departed_member_guard()` on the scratch databases
  it creates.
- **First run:** 44 rows; 39 proved, and the five below did not.
  - **22b (fire on `→ NULL`):** no cell could redden it. Each existing return cell has no record
    later than an active row's admission, so judging the return refused nothing.
    - Added the T4 allow cell "a return of a user whose row a later record keeps leftover". It pins
      that a return is not judged (Q3).
    - Re-run: that cell is red with `departure_leftover`. Proved.
  - **23 and 24 (lock removal):** the plan paired each lock with the wrong cells.
    - The activation lock is the waiter's lock in R1 "stamp holds" and R2 "departure holds".
    - The departure-check lock is the waiter's lock in R1 "re-activation holds" and R2 "INSERT
      holds".
    - Re-run with those sets: each row's two cells are red and nothing else. Proved. All four R1/R2
      cells are covered.
  - **27 (bypass restore):** the two "refused" T6 cells roll back to a savepoint after the refusal.
    That rollback reverts `set_config(…, true)` whether or not the function restored the settings,
    so no client cell can see the restore on a refusal path.
    - Those cells stay as behavioural assertions and are marked caveats in the row.
    - The two "passing" cells are red, plus six production-writer, accept, key and scenario-5 cells
      through the leaked bypass. Proved.
  - **30 (`advisoryKey` case):** only R1 "stamp holds" and R2 "departure holds" hold the key
    through TypeScript alone. A held activation takes the lowercase key again in its own trigger.
    Re-run with those two: both red. Proved.
  - The plan's C7 T5 text and red-proof table now say this.
- **Final:** all 44 rows proved. Rows 25 (grant-arm lock) and 25x (key-write lock) confirm the D4
  scenario-5 note. The route recipient-check rows R1–R5 and R2x are red by status at unit level,
  and by the guard's error at integration level.
- **VE3, on a fresh scratch database:** CI grants, `migrate deploy` (231 migrations), the RLS smoke
  seed and verify, the cross-tenant seed, coverage, verify as `passwd_app`, and the negative test
  with `RLS_NEGATIVE_MUTATE_REAL_POLICY=1` all exit 0.
- **10b red-proof:** removing the guard's allowlist lines exits 3 with `E-RLS-BYPASS-ROUTINE`.
- **C4 parameter class:** re-run. Each of the three runs exits 1 with its `PARAMETER:` key, and
  nothing is left in the role catalogs.
- **Left untouched:** in `passwd_sso_wt_1060` the function is byte-identical to the migration, the
  six triggers are enabled and the index is present. No scratch database or `RP_` enum label
  remains.

## D6 — pre-pr: the cross-tenant SQL parse step runs against the shared dev database

- **What failed:** `pre-pr.sh`'s "rls-cross-tenant SQL parse" runs `rls-cross-tenant-verify.sql` against `passwd_sso`. That is the shared dev database, which carries main's migrations only. The cast `'public.departed_member_guard()'::regprocedure` therefore fails there, because the function does not exist yet.
- **Why it is not a defect here:** the same thing happens to any migration that adds an allowlisted bypass routine, and `share_creator_admitted` is cast the same way. CI runs `migrate deploy` before verify.
- **Replacement evidence:**
  - The same step against `passwd_sso_wt_1060` stops only at the whitelisted `E-RLS-TENANTS-SEED`.
  - VE3 (D5) ran the whole verify, exit 0, on a fresh, migrated, seeded database.
- **What was not done, and why:** the migration was not applied to the shared dev database. Other sessions use it, and a feature-branch migration there would drift it from main.
- **All 86 other pre-pr steps pass.**
