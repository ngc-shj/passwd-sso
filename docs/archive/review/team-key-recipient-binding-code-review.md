# Code Review: team-key-recipient-binding
Date: 2026-11-20
Review round: 1

## Changes from Previous Round
Initial review (incremental on top of the Phase 2 self-R-check, deviation D11–D14). Seeds
unavailable (Ollama returned empty output); every expert reviewed the full diff against
`origin/main`.

## Functionality Findings
- **F1 [Minor]** `team_key_recipient_guard()` / `users_ecdh_key_guard()` wrap the bypass read in a
  `BEGIN … EXCEPTION WHEN OTHERS THEN RAISE; END` block. The handler only re-raises, but the
  block runs as a subtransaction and the row lock inside it gives each one an XID: a rotation of
  up to 1000 members (`TEAM_ROTATE_MEMBER_KEYS_MAX`) collects up to 1000 subtransaction XIDs and
  suboverflows while the rotation transaction is open. `departed_member_guard` takes no row lock in
  its block.
- **F2 [Minor]** On teams POST the recipient is the creator: a 409 `TEAM_KEY_RECIPIENT_CHANGED`
  means their own vault changed elsewhere, and a retry in the same tab hashes the same stale
  in-memory key. The shared "A member's vault changed … try again" text misleads there.
- **F3 [Minor, Adjacent → testing]** `e2e/helpers/db.ts` `seedUser` without `vaultFields` keeps a
  leftover ECDH key, so a later UI vault setup on that user is now refused (`ecdh_key_overwrite`)
  instead of failing at seeding.
- **F4 [Minor]** Deviation log has two sections numbered D13.

Implementation Checklist cross-check: every listed file is in the diff;
`db-grants-manifest.json` correctly unchanged (trigger functions need no manifest entry).

## Security Findings
No findings. Writer sets (team-key writers; `ecdh_public_key` writers) re-derived from code; reset
cannot refuse itself (rows cleared under `users FOR UPDATE` before the key is nulled); setup NULL→P
not judged, so no user can block another's setup or reset; lock order adds no edge (FOR KEY SHARE is
the FK's lock); bypass save/restore, pinned `search_path`, `REVOKE EXECUTE … FROM PUBLIC`; C9 only
removes rows no held key can unwrap; a malicious distributor is outside the threat model (S3, they
already hold the team key); messages carry only UUIDs and a fixed token.

## Testing Findings
- **F1 [Major] RT10** No allow cell for an UPDATE that rewrites the wrap and keeps a fingerprint
  matching the current key; a mutation refusing every inherited fingerprint passes the suite, and in
  production would wedge confirm-key's update branch over a row already bound to the current key.
- **F2 [Major] RT7/RT6** `check-bypass-rls`'s `routine: null` matcher branch has no self-test; the
  "no implicit wildcard" claim (D14) is unproven.
- **F3 [Minor] RT7** Red-proof row 11a goes red on enforce-mode RLS before the C2 `readGucs`
  restore assertion; that assertion's own ability to fail is unproven.
- **F4 [Minor] R29** Row 21's note says "sees no row to repair" while it pins a loud
  `RLS_BYPASS_NOT_GRANTED`; the silent no-bypass case the plan names is not run.
- **F5 [Minor] R40** The teams POST success cell takes the creator's key from the DB, not from a
  serving endpoint (`/api/vault/unlock/data`), unlike the confirm-key and rotation round trips.
- **F6 [Minor]** `seedUser`'s positive control asserts only a call count.
- **F7 [Minor]** Duplicate D13 (same as Functionality F4).

## Adjacent Findings
- Functionality F3 (e2e `seedUser` else branch) — testing scope; resolved with it.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R3, R5, R12, R14, R17, R25 (N/A), R29, R38, R40, R42, R48, R52, R55: checked, OK; R24: accepted
  deviation D11.

### Security expert
- R1, R2, R3, R5, R6, R14, R15, R31, R38, R42, R43, R48, R54: OK; R24: accepted (D11); others N/A.
- RS1 N/A (fingerprint is public, compared in SQL); RS2 N/A (no new routes); RS3 OK (Zod regex and
  column CHECK both require 64 lowercase hex); RS4 OK; RS5 N/A; RS6 N/A.

### Testing expert
- R3, R12, R17, R19, R21, R33, R42, R50, R54: OK; R29: F4/F7; R40: F5.
- RT1, RT3, RT4, RT5, RT8, RT9, RT11: OK; RT2: not raised (`recipient_row_unlocked` unreachable);
  RT6: F2; RT7: F2, F3; RT10: F1.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 beyond those recorded in the deviation log
(D4/D7: MinIO-backed integration files, `audit-db-grants` on a scratch database).

## Resolution Status
### Round 1 (deviation log D16)
- **Func F1 [Minor]** Both guards' exception sub-block removed (flat set → read → restore); applied
  in place to the worktree database with its migration checksum. New cell: a lock-timeout (55P03)
  inside the guarded read, rolled back to a savepoint, leaves the caller's own bypass settings.
  Rows 02–09, 11a, 11b, 13b regenerated; all rows re-proved.
- **Func F2 [Minor]** `team-create-dialog.tsx` maps the creator's 409 to `Team.createVaultChanged`
  (en/ja: reload and unlock again); rotation and distribution keep the shared text.
- **Func F3 / Testing adjacent [Minor]** `e2e/helpers/db.ts` `seedUser` without vault fields is
  guarded by `ecdh_public_key IS NULL` and throws on a keyed user; both cases pinned.
- **Func F4 / Testing F7 [Minor]** Second D13 renumbered D15, cross-referencing D14.
- **Testing F1 [Major]** Allow `it.each` over the eight wrap columns (incl. `user_id` to another
  member holding the same key) on a row bound to the current key, plus confirm-key's update branch
  over an already-current row (200, same row, rewritten wrap). Row 05b (refuse every inherited
  fingerprint) reds all nine; no deny cell moves.
- **Testing F2 [Major]** `check-bypass-rls.test.mjs` pins the `routine: null` entry: the runner's
  dynamic CREATE passes, a literal `CREATE FUNCTION evil()` in the same file fails, an unmatched
  entry reports "dynamic name". Red-proved: matcher `e.routine === null ? true : …` reds the
  `evil` cell.
- **Testing F3 [Minor]** Row 11a2 (tables/purpose restores removed, `bypass_rls` restore kept) reds
  the C2 `readGucs` assertion (`tables: 'users'`).
- **Testing F4 [Minor]** Row 21's note corrected; row 21b (both bypass settings dropped from C9)
  proves the silent no-op case (`active residue repaired`).
- **Testing F5 [Minor]** teams POST success cell takes the creator's key from
  `/api/vault/unlock/data` and fingerprints it with the production function.
- **Testing F6 [Minor]** `seedUser` positive controls assert the second query is the
  `tenant_members` insert.

Verification: tsc 0; lint 0; unit 1206 files / 25725 passed; `next build` 0; integration (new file
54 cells + departed-member-db-invariants) 193 passed; red-proofs: all 26 team-key rows and #1074 rows
01/27/R1y PROVED; `check:bypass-rls` 0; VE3 fresh-database RLS sequence green (10b red by design,
`audit-db-grants` environment-only per D7).

## Round 2 (fix commit 4f7b7972c, after rebase onto origin/main)
### Functionality Findings
No findings. The removal of the exception sub-block is equivalent on every path: the old handler
only re-raised, so the restore was skipped on error before as well; every way a caller can catch
the error (`ROLLBACK TO SAVEPOINT`, an outer plpgsql handler) is a subtransaction abort that reverts
the transaction-local settings. `seedUser` call sites checked; the creation message is correct for
both `recipient_key_changed` and `recipient_no_key`.

### Security Findings
- **S1 [Minor] R47** The `routine: null` entry exempted any routine whose name the text regex fails
  to capture (`CREATE FUNCTION /**/evil()`, a non-ASCII name, another variable) in the runner file.
- **S2 [Minor, Adjacent]** No savepoint cell for `users_ecdh_key_guard`'s error-in-window path.
No R43 widening: bypass tables and purposes are byte-identical to Round 1; nothing between set and
restore writes, fires a trigger, or resolves a name through the caller's `search_path`; no
production code catches these errors in a savepoint or handler.

### Testing Findings
- **T-R2-1 [Minor] RT7** The Round 1 savepoint cell's restore assertions pin PostgreSQL's
  subtransaction rollback; no guard mutation can red them (its guard-sensitive part is the 55P03 /
  `where` precondition, row 06).
All Round 1 testing findings verified closed; the collateral `+` lines added to rows 05/06/11a are
mutation-caused (failure messages read).

### Recurring Issue Check
- Functionality: R3, R5, R9, R12, R14, R17, R29, R38, R40, R42, R43, R48, R52, R54 OK; R24 accepted
  (D11); R15, R25, R55 N/A.
- Security: R1/R3, R14, R37, R43, R49, R54 OK; R47 → S1; RS1 N/A, RS2 N/A, RS3 OK, RS4 OK, RS5 N/A,
  RS6 N/A.
- Testing: R19 N/A; R44/R50 OK; RT1, RT2, RT4, RT5, RT8, RT10, RT11 OK; RT3, RT6, RT9 N/A; RT7 →
  T-R2-1.

### Resolution Status — Round 2
- **S1** The runner's entry is now `dynamic: "${qualified}"`: it admits a match that read no name
  only when the raw token after FUNCTION is exactly that spelling. Self-tests added for a comment
  before the name, a non-ASCII name and another variable (each refused, "creates a routine");
  red-proved by reverting the matcher to `routine === undefined` alone (the three cells red).
- **S2** Twin cell: a FOR KEY SHARE holder on the recipient's row (a FOR UPDATE holder stops the
  UPDATE at the executor's own tuple lock, before the trigger — probed: `where` names only
  "while locking tuple"), P → NULL under a SAVEPOINT with `lock_timeout`, 55P03 inside
  `users_ecdh_key_guard()`, rolled back, caller's settings and RLS filtering intact. Row 08 (C3's
  FOR UPDATE dropped) now requires it (`expected null to be '55P03'`) and proves.
- **T-R2-1** Comment on both savepoint cells and a note in D16: the restore assertions pin
  PostgreSQL's rule the removal relies on; the guard-sensitive parts are the preconditions
  (rows 06 and 08); the guards' own restores are the C2/C3 restore cells (rows 11a/11a2/11b).

## Round 3 (fix commit 98a738635)
### Functionality Findings
No findings. The raw token after FUNCTION is `${qualified}` for the runner's line; named entries,
the prefix entry and the code-file path are unaffected; the stale-entry message still reads
"dynamic name". The users-guard cell's lock-mode premise holds (`ecdh_public_key` is not a key
column, so the UPDATE takes FOR NO KEY UPDATE).

### Security Findings
S1 and S2 closed (spellings probed against the gate's regex: every admitted one creates the routine
`$qualified` names or is a SQL syntax error). No R43 widening (strict subset of Round 2).
- **MIN-1 [Minor] R51/R49** The `dynamic` entry admitted any number of `${qualified}` CREATEs in the
  runner, and its `why` overstated what the match is: the matched line is `extract_function`'s awk
  key, not a creation.
- **MIN-2 [Minor] R55/R47** A file entry with neither `routine` nor `dynamic` (a typo) would compare
  `undefined` to every unread name and admit it.

### Testing Findings
T-R2-1, S1/S2 pins and row 08's required cell verified (deterministic: holder committed before the
statement, `SET LOCAL` in a rolled-back transaction).
- **T-R3-1 [Minor] RT7** The "exact spelling" claim was not pinned against a prefix/suffix/substring
  comparison.

### Recurring Issue Check
- Functionality: R3, R17, R29, R42, R43, R47, R48, R52, R55 OK; others N/A for the delta.
- Security: R3, R29, R43, R54 OK; R47/R49/R51/R55 → MIN-1/MIN-2; RS1–RS3, RS5, RS6 N/A; RS4 OK.
- Testing: R44, R50 OK; RT1, RT2, RT4, RT5, RT8, RT10, RT11 OK; RT3, RT6, RT9 N/A; RT7 → T-R3-1.

### Resolution Status — Round 3
- **T-R3-1** Refused cells for `${qualified}_evil()` and `/**/${qualified}()`; red-proved with the
  comparison mutated to `includes` (both red, the other three green).
- **MIN-1** A `dynamic` entry admits one site: a second match is a violation naming the first line.
  The entry's `why` now says the match is the awk key. Self-test appends a second
  `${qualified}` CREATE (exit 1); red-proved by disabling the count.
- **MIN-2** The allowlist's shape is checked at load: each file entry names exactly one non-empty
  `routine` or `dynamic`, else the gate throws. Self-test runs a copy of the gate with the runner
  entry's key misspelt (refused); red-proved by disabling the check.

## Round 4 (fix commit 78fa28a4a)
### Findings
- Security MIN-1 / Functionality F-R4-1 [Minor] R48 (converged): the load-time shape check counted a
  key only when it was a non-empty string, while the matcher and counter read `dynamic !== undefined`;
  `{ file, routine: "x", dynamic: "" }` loaded and was matched as a dynamic entry admitting an empty
  token. File-less and prefix-hybrid entries were not checked.
- Testing T-R4-1 [Minor] RT7: the second-site cell did not pin "(first at line N)".
- Round 3 MIN-1/MIN-2/T-R3-1 verified closed; counter per entry and bound to its file; no R43 widening.

### Recurring Issue Check
- Security: R43, R47 OK; R48 → MIN-1; RS1–RS6 N/A. Functionality: R3, R17, R29, R42–R44, R47, R49–R52,
  R55 OK; R48 → F-R4-1. Testing: RT1, RT2, RT5, RT8–RT11 OK; RT3, RT4, RT6 N/A; RT7 → T-R4-1.

### Resolution Status — Round 4
- **MIN-1 / F-R4-1** One presence rule (`!== undefined`) in the shape check, as in the matcher: an
  entry is `{ prefix }` alone or `{ file, routine }` / `{ file, dynamic }`, every value a non-empty
  string, else the gate throws at load. Self-test `it.each` covers a misspelt key and
  `routine: "x", dynamic: ""`; the latter red-proved against the Round 3 check.
- **T-R4-1** The second-site cell asserts the full detail including `(first at line N)`, N derived
  from the runner text; red-proved by reporting the current line instead.

## Round 5 (fix commit 2e23cbace)
Functionality: No findings (shape check, matcher and counter agree on every entry that loads; extra
keys such as `why` are not read by the matcher and are correctly outside the checked set).
Security: No findings (the Round 4 fail-open entry and prefix-with-file entries are refused at
load; no R43 widening).
Testing: **T-R5-1 [Minor] RT7/RT10** — the shape-check self-test did not cover a prefix beside a
file entry (the widening direction).

### Recurring Issue Check
- Functionality: R3, R17, R29, R42, R44, R47–R49, R51, R52, R55 OK. Security: R43, R47, R48 OK;
  RS1–RS6 N/A. Testing: RT1, RT2, RT5, RT8, RT9, RT11 OK; RT3, RT4, RT6 N/A; RT7/RT10 → T-R5-1.

## Tightening-only skip — Round 5
Findings applied directly (no Round 6 review):
- [T-R5-1] [Minor] shape-check self-test lacked the prefix-with-file row —
  `scripts/__tests__/check-bypass-rls.test.mjs` (the shape-check `it.each`) — row added; red-proved
  by relaxing `keys.join() === "prefix"` to `keys[0] === "prefix"` in the gate (the row reds, the
  others stay green); the gate itself is unchanged.
Justification: the finding is within Round 4's fix scope, a test-only row that changes no gate
behaviour or boundary, and it is proven able to fail.

## Termination
Rounds: 5. Every Critical/Major resolved (Round 1 Testing F1, F2); every Minor resolved; no
skipped or accepted findings. Accepted plan-level deviation: D11 (R24, rollout window).
