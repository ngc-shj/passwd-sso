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
