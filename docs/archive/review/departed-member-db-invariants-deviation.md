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

## D7 — Step 2-5 self-R-check: findings and dispositions

- **R42 (functionality and security, Major):**
  - **Gap:** the PARAMETER class reads only a per-role `session_replication_role` default. An `ALTER DATABASE … SET` or an `ALTER ROLE ALL SET` default (`setrole = 0`) reached every `passwd_app` session too. The audit reported it only as an unexpected `ROLESETTING:` key, which `--write` would have recorded as the baseline.
  - **Fix:** `session_replication_role` joins `DENIED_SETTING_RE`.
  - **Proof:**
    - three unit cells, which go red with the name removed (scratch copy);
    - a throwaway database made from the worktree template, with the database default set: the audit exits 1 with `DENIED_SETTING_HELD`, `--write` refuses, and the database is dropped.
- **RT7/R50 (Major), the runner verdict:** PROVED ignored unexpected reds and the arm token.
  - **Fix:** a row now proves only when every required cell fails at its pinned assertion naming its arm token, and nothing outside the listed cells goes red. Since Phase 3 T4, a deny cell's failure also prints the actual outcome (`actual=<arm|committed>`). For a deny cell, the token alone does not prove the reason, because the expectation prints it too. Base-green plus no unlisted red is what rules out an unrelated cause.
  - **Collateral reds:** those the earlier runs observed are listed per row as `+` lines (allowed, not required).
  - **Row 11:** its cell now compares the token on its own. Vitest truncated the expected object, so the token never reached the message.
- **R44 (Minor), the runner:** `run_row` runs under `||`, so `set -e` was off inside it. Scratch creation, `setup.sql`, `patch` and the mutation's `pg_exec` now return explicitly.
- **RT11 (Major), the re-admit cell:** an aborted runbook script would have returned its pooled connection still inside the transaction that holds `team_members`' lock. It now rolls back on error, as `runScript` does.
- **RT7 (Minor):** the one-statement cell asserts 42601, not any error.
- **R36 (Minor):** the row-11 fixture imports helpers through the `@/` alias, so `tsconfig.json` needs no exclude.
- **RT3/R1 (Minor), not changed:** existing tests that build the advisory key by hand stay as written. They are an independent oracle for `advisoryKey`'s spelling.
- **Full matrix re-run under the stricter verdict:** see D8.

## D8 — Full red-proof matrix under the stricter verdict

- **First full run after D7 (44 rows):** all 44 proved.
  - The verdict requires each required cell to fail at its pinned assertion naming its token, and no unlisted cell to go red.
  - The `+` collateral lines added in D7 came from the earlier runs' observed reds. None had to be widened.
- **After the Phase 3 round-1 fixes (47 rows):** 46 proved on the first pass.
  - New rows:
    - R1y: the confirm-key CAS after the key write again;
    - 15b: `tenant_mismatch` refuses endings again;
    - 16b: no record re-key guard.
  - Regenerated against the new function: rows 12, 15 and 16. Row 15 also requires the new raise-on-a-mismatched-row cell.
  - Regenerated against the new route: row R1.
  - **Row 31a:** it reddened one cell it did not list, the new superuser record re-key cell. Its seed helper's leaked `session_replication_role` turns the trigger off on the shared superuser connection, the same way it reddens the superuser re-key cells it already listed. That cell was added as a `+` line, and the row re-run proved.
- **Result:** all 47 rows proved. Each run's `summary.tsv` is in the scratchpad (`run-all2`, `run-all3`, `r31a`).

## D9 — Phase 3 round 2: changes the plan did not foresee

- **confirm-key order (round 2 N1).**
  - The round-1 F1 fix moved the CAS before the key write. That locks the member row before the recipient's users row, and the users lock is taken implicitly by the key insert's FK check. This breaks the documented order teams → users → team_members and deadlocks with a vault reset, which locks users FOR UPDATE and then the member rows.
  - **Fix:** restore the original order. The guard's `key_inactive` refusal of the key write is answered as the 404 a CAS miss gets. It is read through `departedMemberGuardArm` (`src/lib/team/departed-member-guard.ts`), the same nestings `pgConstraintName` reads.
  - **Pins:**
    - a unit cell for the call order;
    - a unit cell for `key_inactive` → 404, and one showing that any other guard arm is not mapped;
    - the integration race cell (the ending commits while the key write is parked: 404, no key).
  - **Red-proof rows:**
    - R1y: the mapping removed;
    - R1z: the CAS first again, which reddens the order cell and the race cell.
- **Re-keying a departed tenant row (round 2 S2-1).**
  - The docs called it app-enforced, but rule 2 reads only `deactivatedAt` writes and the AST pin reads only deletes.
  - **Fix:** a new BEFORE UPDATE OF `tenant_id`, `user_id` trigger refuses it with `tenant_row_rekeyed`. This makes seven triggers.
  - **Cells changed:** the two pairs that re-keyed a departed row (the commit-time judgement of the new key) are replaced. Both re-keys are now refused at the statement; the pair cell is an active row re-keyed by `user_id`, which commits.
  - **Red-proof rows:**
    - 09a and 09b (the `_upd` firing on `tenant_id` / `user_id`) are retired. The BEFORE arm refuses every write they reached, so no cell can redden them while it stands. The firing stays as a second line behind the arm.
    - Row 09c removes the arm.
- **SCIM user DELETE (round 2 N3).** This was the SC3 window: a key row left behind for an absent membership. Member rows are now deleted before keys, so a concurrent distribution either holds the member row, and its committed key is then deleted, or rolls back. Pinned by a race cell and red-proof row R6.
- **`--write` on a parameter privilege alone (round 2 test N1):** T8e also runs `--write`. Red-proof: removing `parameters.length > 0` from the refusal condition reddens both T8e cells (scratch tree, scratch database).
- **The two halves of `(v_activation OR v_grant)` (round 2 test N2):** rows 15c and 15d.
- **The runbook's FK-cascade line (round 2 N2):** now says a cascaded id change is refused once it reaches a departure record or a departed tenant row.
- **Matrix after round 2 (50 rows):**
  - 49 proved on the first pass.
  - Row 31a reddened the renamed superuser tenant-row re-key cells, the same collateral it already listed under their old names. They are listed under the new names, and the row re-run proved.
  - Stale `+` lines naming the removed cells were dropped from rows 17 and 20.
  - **Result:** all 50 rows proved.

## D10 — Phase 3 round 3

- **`_upd` firing (test F1):** `tenant_members_departure_ends_memberships_upd` now fires on `UPDATE OF deactivated_at` only.
  - Its `tenant_id` / `user_id` columns could matter only for a departed row's re-key, which the round-2 BEFORE arm refuses first. That made them unprovable dead code.
  - Row 22b's mutant is rewritten against the narrowed trigger.
- **Cell placement and plan (test F2, F3):**
  - The tenant-row re-key cells now sit under "refused at the statement". Their active-row pair sits under "allowed".
  - Rows 09c and 31a name the new cells.
  - The plan's C7 lists, trigger table and red-proof table describe the current cells and rows.
- **Anti-Deferral: confirm-key wraps to a recipient key that a vault reset has retired (functionality round 3 F1, security round 4 S4-2, functionality round 4 R4-F1; [Adjacent], pre-existing on main).**
  - **The defect:** the distributor's client wraps the team key to the recipient's `ecdhPublicKey`, which it fetched from `/api/teams/pending-key-distributions`. confirm-key checks only that some ECDH key exists, outside its transaction. Nothing ties the wrapped key to the recipient's current key.
  - **The window:** it runs from that fetch to the commit. It includes a full reset followed by a re-setup, after which the recipient has a new, non-null key. The CAS still matches, because a reset sets `keyDistributed = false`.
  - **What closes it:** binding the request to the key it wrapped to, with the client sending that public key or its fingerprint and the server comparing it with the recipient's current key under a lock. Two other designs would not close it:
    - an in-transaction re-read of `users` under a lock only catches a reset that has not been followed by a re-setup;
    - a post-commit compensating write has the same blind spot.
  - **Why it is not fixed here:** the binding changes the distribution protocol (client, API and server comparison), and the server-side comparison needs the recipient's `users` row inside the team-tenant transaction. A cross-tenant guest's row is invisible there, routes have no sanctioned in-transaction bypass pattern, and the RLS-nesting guard refuses a nested `withBypassRls`. That is a protocol and RLS design decision outside the departed-member invariants.
  - **Worst case:** the member holds `keyDistributed = true` with a key wrapped to their retired ECDH key, until a team key rotation or another vault reset of their own. Redistribution is blocked by `KEY_ALREADY_DISTRIBUTED`. A holder of the retired private key could also unwrap that team key version. That means the member themself, or whoever stole the old key when a compromise prompted the reset, and they would still need a fresh authenticated session as the member, since a reset revokes sessions.
  - **Likelihood:** low. It needs a reset of the recipient between the distributor's fetch and the confirm-key commit.
  - **Cost to fix:** the protocol change above, plus its gates and tests. That is larger than this PR's remaining scope, and the defect is unchanged from main.
  - **Disposition:** reported in the PR description as a known pre-existing limitation, with the binding named as the fix.

## D11 — Phase 3 round 4

- **Active tenant-row re-key (security S4-1, pre-existing).**
  - Re-keying an active tenant row away from a key that has a departure record leaves that key departed: no row, a record, and active memberships. Neither the database nor a gate saw it.
  - **Fix:** the re-key guard now refuses every `tenant_id`/`user_id` change on `tenant_members`, since nothing legitimate does it. It is renamed `trg_tenant_members_rekey_guard`.
  - **Cells:** the active-row pair cell became a deny cell, re-keying an active row away from a key with a record. The new pair is a non-key column change on an active row.
  - **Red-proof rows:** 09c drops the arm; 09d limits it to departed rows again.
- **D10's Anti-Deferral is restated** (security S4-2, functionality R4-F1): the window, what closes it, the worst case and the recovery path.
- **Template check (functionality R4-F2):** before the matrix run, the template's live definitions were read back.
  - `pg_get_triggerdef` lists the seven triggers as the migration defines them, including `_upd` on `UPDATE OF deactivated_at` only and `trg_tenant_members_rekey_guard` with no WHEN.
  - `md5(prosrc)` equals the md5 of the migration's function body (`b9ed9e9d…`).
- **Matrix after round 4:** all 51 rows proved, on a template whose definitions were read back as described above.

## D12 — Phase 3 round 5 (documentation and test tightening)

- **Runbook:** the refused list names `tenant_row_rekeyed` and `record_rekeyed`. The "does not judge" list now names the orphan-record class: deleting an active row whose user has a record, or a delete followed by an insert onto another key. The scope of the FK-cascade line is corrected.
- **Orphan-record class:** stated the same way in the migration header, plan Q3 and the runbook.
- **Cells:**
  - The active re-key deny cell covers both with and without a departure record, so the "refuses any re-key" contract is pinned.
  - The pair writes a key column with its own value plus a role change, and asserts the role changed. That fires the guard and pins its `IS DISTINCT FROM` predicate. Row 09e mutates that predicate to `true`.
- **Wording:** the plan's round labels and the round-3 code-review resolution's impact wording are corrected.
- **Red-proof:** rows 09c, 09d, 09e and 31a proved after these changes. The final full matrix is recorded below.
- **Final full matrix:** all 52 rows proved (`run-all7`).
