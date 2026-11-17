# Code Review: departed-member-db-invariants
Date: 2026-11-17T11:06:08+09:00
Review round: 1

## Changes from Previous Round
Initial review. It came after the Phase 2 self-check (deviation log D7). The Ollama seeds and pre-screening were unavailable, so every expert reviewed the full diff.

## Functionality Findings
- **F1 Major — confirm-key returns an unmapped 500 when the recipient is ended between its read and the key write.**
  - The route reads the member row with no lock and writes the key before its CAS.
  - An ender holds the team only `FOR SHARE`: `endTeamMemberships` under `lockTeamsAgainstRotation`, or SCIM group removal. If one commits in that window, the guard refuses the key with `key_inactive`. Before this branch the same interleaving answered 404.
  - Fix: run the CAS first.
- **F2 Minor — `tenant_mismatch` refuses the writes that end a membership too.** A membership left with a tenant other than its team's then wedges its user's departure and containment.
- **F3 Minor [Adjacent] — the deviation log cites a D8 that does not exist.** Same as T8.

## Security Findings
- **S-1 Minor — re-keying a departure record erases a departure.**
  - The record guard refused only a lowered `departed_at`. An UPDATE of a record's `tenant_id` or `user_id` passed, and it erases the departure as a DELETE would. passwd_app holds UPDATE on the table and no DELETE.
  - Re-keying a departed tenant row is another undo of a departure that was not on the list.
- No Critical or Major findings.

## Testing Findings
- **T1 Major — `ci-integration.yml` does not list the runbook.** Two integration files run `docs/operations/departed-member-access-backfill.md` verbatim, but a change to the runbook alone does not trigger the integration job.
- **T2 Major — the PARAMETER class's live SQL has no automated test.**
- **T3 Major — the re-admit script's new refusals have no deny cell.** The two refusals are a guard that is not in its enabled state, and a role that does not own the table.
- **T4 Minor — the runner's token check reads the expected arm.** For a deny cell, the token in the failure message comes from the test's expectation, not from the actual outcome.
- **T5 Minor — the runner ignored INT/TERM.** The trap did not exit, so the next row started.
- **T6 Minor — the F2-2 "lowered restamp" assertion could not fail.**
- **T7 Minor — R3 did not assert that the held side holds the advisory key.** Its post-commit "blocked" check was always empty.
- **T8 Minor — D7 cites a D8 that does not exist.**
- **T9 Minor — the exact-list assertion for `departed_member_guard` in 10b was never red-proved.**

## Adjacent Findings
- F3: the deviation log cites a D8 that does not exist. Resolved together with T8.

## Quality Warnings
None. Every finding names a file, a line and a reproducing mechanism.

## Recurring Issue Check
### Functionality expert
- R5: F1.
- R29 / R49: F1 refutes C1's key-writer claim. F2 shows that "not judged" understates the re-homing behaviour.
- R38: F2.
- R42: confirm-key is a new member of the key-writer race.
- Checked: R3, R14, R15, R24, R48, R52.
- Every other rule: not applicable.

### Security expert
- R42: S-1.
- Checked: R1–R3, R5, R14–R19, R22, R24, R29, R31, R34–R36, R38, R41, R43, R44, R47–R55, and RS1–RS6 (OK or not applicable).
- R3: the advisory-key spelling was verified at every site.
- R14: only passwd_app does invoker reads.
- R18: both allowlists were updated.
- R54: the bypass save/set/restore was verified.

### Testing expert
- R29 / R50: T8.
- R49: T4.
- RT4: T7.
- RT5 / RT7: T2, T3, T9.
- RT10: T3.
- RT11: T5.
- R33 / R34: T1.
- Checked: RT1, RT3 (the hand-built advisory key stays as an independent oracle, D7), RT6, RT8.
- Not applicable: RT9.

## Environment Verification Report
| Path | Classification |
|---|---|
| The integration suite (new and adopter files) on `passwd_sso_wt_1060` | verified-local |
| `audit-db-grants.integration.test.ts` on a scratch copy without the retired role's CONNECT (the D4 difference) | verified-local, 48/48 |
| VE3 CI sequence | verified-local on a fresh scratch database (D5) |
| VE4 red-proof matrix | verified-local, full re-run (D8) |

## Resolution Status
### F1 Major — confirm-key CAS after the key write
- **Action:** the CAS (`deactivatedAt: null, keyDistributed: false → true`) now runs before the key upsert. Its row lock holds off an ending until commit, and an ending that committed first misses as a 404.
- **New tests:**
  - unit: the CAS miss writes no key;
  - integration race: a park trigger sorted before the guard holds the key write. The ending waits on the CAS row lock (witnessed), and the request answers 200.
- **Red-proof:** row R1y puts the CAS back after the key write. The race cell then fails with `DEPARTED_MEMBER_GUARD:key_inactive`, and the unit cell fails too.
- **Modified files:**
  - `src/app/api/teams/[teamId]/members/[memberId]/confirm-key/route.ts` (the CAS before the upsert);
  - `route.test.ts`;
  - `departed-member-leaked-authority.integration.test.ts`;
  - `check-bypass-rls.mjs` (an allowlist entry for `c1_confirm_key_park`).

### F2 Minor — tenant_mismatch on endings
- **Action:** `team_members` judges `tenant_mismatch` only when the write is an activation or a grant. Key writes still always judge it.
- **New cells:** a role raise on a mismatched row is refused; ending one commits.
- **Red-proof:** row 15b refuses endings again, and the allow cell reddens with `tenant_mismatch`. Row 15 now also requires the raise cell.
- **Docs:** the plan's arm table and its not-judged list, and the runbook's "It does not judge" list.

### S-1 Minor — departure-record re-key
- **Action:** a new arm, `record_rekeyed`, refuses a change to a record's `(tenant_id, user_id)`. Raising or keeping `departed_at` still passes, and so does the SCIM upsert.
- **New cells:** a re-key by `user_id` (app) and by `tenant_id` (superuser).
- **Red-proof:** row 16b. Row 16 was regenerated against the new function.
- **Docs:** re-keying a departed tenant row is added to Q3, to the plan's not-judged list and to the runbook.

### T1 Major — CI path filter
- **Action:** the runbook is listed in the `integration` filter.
- **Pin:** a cell in `audit-anchor-vectors-ci-filter.test.mjs` checks that both suites still read the runbook, that the filter lists it by name, and that the filter has no `docs/` wildcard.

### T2 Major — the PARAMETER class SQL
- **Action:** new cells T8e (SET, ALTER SYSTEM) and T8f. T8f sets a role default scoped to the test database; the audit reports both `PARAMETER … ROLE_DEFAULT` and `DENIED_SETTING_HELD`, and `--write` refuses.
- **Red-proof:** on scratch tree copies, removing `SET` from `PARAMETER_PRIVILEGES` reddens only T8e SET, and removing the ROLE_DEFAULT `UNION` arm reddens only T8f.

### T3 Major — re-admit refusals
- **Action:** two new cells.
  - `ENABLE ALWAYS` on the guard: refused with "is not in its enabled state". Nothing is written, `tgenabled` stays `A`, and it is restored to `O`.
  - Run as passwd_app: refused with 42501 "must be owner of table team_members", and nothing is written.
- **Red-proof:** with the `tgenabled` block removed from a runbook copy (`RUNBOOK_MD`), cell (a) goes red.

### T4 Minor — runner token check
- **Action:** a deny cell's failure now prints `actual=<arm|committed>`. The runner's comment and D7 now say what the check proves: the cell failed at its pinned assertion, naming its arm. That is not the same as "red for its own reason". Base-green and no-extra-red remain the conditions that rule out an unrelated cause.

### T5 Minor — runner signals
- **Action:** `trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM`.
- **Check:** SIGTERM during row 1 of 2 exits 143. Row 2 never starts and no scratch database remains.

### T6 Minor — F2-2 assertion
- **Action:** `runTx` returns each step's rows. The cell compares the final stamp with the placeholder that the INSERT returned, both read from `clock_timestamp()` in one transaction.
- **Red-proof:** dropping the restamp gives "expected X to be less than X".

### T7 Minor — R3 precondition
- **Action:** the cell now asserts that the held side holds the advisory key before the grant runs. The post-commit check, which was always empty, is gone.
- **Red-proof:** when `lockTenantRows` does not take the advisory lock (scratch tree), R3 is red.

### T8 / F3 Minor — D8
- **Action:** D8 records the full matrix re-run under the stricter verdict.

### T9 Minor — 10b exact-list assertion
- **Red-proof:** on scratch databases, verify exits 3 with `E-RLS-BYPASS-ROUTINE … departed_member_guard no longer sets exactly …`. This holds both with `team_member_keys` added to the table list and with a third `app.bypass_tables` write.

## Round 2
Date: 2026-11-17

### Changes from Previous Round
Every round-1 finding was resolved. The round-1 fix for F1 introduced one new Major (N1). The other round-2 findings are Minor.

### Findings
- **N1 Major (functionality), new and fix-induced.** Moving the confirm-key CAS before the key write broke the lock order teams → users → team_members, and it deadlocks with `executeVaultReset`.
- **N2 Minor (functionality).** The runbook said FK cascades are not judged. A cascaded id change into a departure record is now refused.
- **N3 Minor [Adjacent] (functionality).** The SCIM user DELETE removed keys before member rows. A concurrent distribution could therefore leave a key with no membership (SC3).
- **S2-1 Minor (security).** The docs filed the re-keying of a departed tenant row under rule 2 and the AST pin. Neither covers it.
- **Test N1 Minor.** No cell checks that `--write` refuses a parameter privilege on its own.
- **Test N2 Minor.** Neither half of `(v_activation OR v_grant)` has a red-proof row of its own.

### Resolution Status
- **N1:**
  - The original order is restored. The guard's `key_inactive` refusal is answered as 404 through `departedMemberGuardArm`.
  - Pinned by unit cells (call order, the mapping, and a check that other arms are not mapped) and by the race cell, now 404 with no key.
  - Red-proofs: R1y (mapping) and R1z (order). See D9.
- **N2:** the runbook's line is corrected, and the migration comment states it.
- **N3:**
  - The SCIM user DELETE now removes member rows before keys.
  - A new race cell (confirm-key parked at its CAS, the DELETE waiting on it) shows that no key outlives the membership.
  - Red-proof: R6.
- **S2-1:**
  - `trg_tenant_members_departed_row_rekey_guard` refuses the re-key with `tenant_row_rekeyed`. The plan, the runbook, the migration comment and the trigger catalog cell are updated.
  - Rows 09a and 09b are retired, because no cell can redden them while the BEFORE arm stands. Row 09c removes the arm.
- **Test N1:** T8e also runs `--write`. Removing the parameter arm from the refusal condition reddens both T8e cells.
- **Test N2:** rows 15c and 15d.
