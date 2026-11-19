# Coding Deviation Log: team-key-recipient-binding

## D1 — C3: a named token for the NOT FOUND raise
The plan says C3 raises when its `FOR UPDATE` lock read finds no row (S5b) without naming a token.
The function raises `TEAM_KEY_RECIPIENT_GUARD:recipient_row_unlocked:`. Unreachable from routes
(the triggering UPDATE has just found the row); like `ecdh_key_change_with_keys` it is rethrown.

## D2 — C9 marker name
The plan writes the BACKFILL block name as `team_key_residue`; the migration uses
`team-key-residue`, matching the hyphenated names of the existing blocks
(`departed-member-credential-residue`). The test reads that name.

## D3 — `readBackfillBlock` red-proof override keyed by migration
The plan (T3-P3) asks for a per-block override variable. The helper now maps a migration directory
to its variable (`RLS_BACKFILL_RERUN_DIR` → `RLS_BACKFILL_RERUN_SQL`, this migration →
`TEAM_KEY_RESIDUE_SQL`). This migration has one block, so the effect is the same.

## D4 — Integration suite: adopters and environment
- Shared helper `recipientKey(su, userId)` (`src/__tests__/db-integration/helpers.ts`): sets the
  key with `UPDATE … WHERE ecdh_public_key IS NULL` then reads the stored string back. An
  unconditional write takes the row lock and deadlocked the tests that already hold `users FOR
  UPDATE`; the conditional form never writes a keyed row (no `P → P'`). The fingerprint comes from
  the production `recipientKeyFingerprint`.
- Adopter classification (C7 derivations re-run):
  - key-row seeders only: session-revocation-atomic-departure, session-revocation-lock-order,
    scim-bulk-approve, departed-member-followups, team-member-key-prune, `user-owned-rows-seed.ts`,
    `e2e/helpers/team-rekey.ts` (+ its unit test), `scripts/rls-cross-tenant-seed.sql`;
  - seeders and route-body builders: departed-member-db-invariants, team-entry-rekey,
    team-attachment-rekey, team-key-rekey-writers, team-rekey-pass, team-rotate-key;
  - seeders, route-body builders and ECDH writers (raw `UPDATE users SET ecdh_public_key` now through
    the helper): team-key-version-guard, departed-member-leaked-authority,
    scim-team-admission-approval, leftover-team-actor-authority, team-tenant-departure;
  - caller only: operator-scripts-rds-shaped (passes `ctx.su`);
  - refused-state seeder, not adopted: departed-member-operator-scripts (its key rows go through
    `writeRefusedState`, triggers skipped);
  - delete-only / prose-only hits (`e2e/helpers/db.ts` cleanup, `helpers.ts` deletes, gate scripts):
    not adopters.
- Side-fixes in adopters: departed-member-db-invariants' trigger-order cell asserted the departed
  guard sorts last on `team_member_keys`; it now asserts the last two are
  `[departed_member_guard, recipient_guard]` (stricter). scim-team-admission-approval A10 and
  departed-member-leaked-authority's `confirmKey` helper fall back to a placeholder fingerprint when
  the member row is already gone (the request is refused before the key write in that case).
- `e2e/helpers/db.ts` `seedUser`: the vault upsert's conflict branch is guarded by
  `WHERE users.ecdh_public_key IS NULL` and throws when it updates nothing (T2-N5).
- #1074 red-proof row R1y's `source.patch` hunk header refreshed; the other source-patch rows apply
  unchanged.
- Environment-only failures (as #1060 D4): MinIO-backed files, `audit-db-grants`,
  `retire-dcr-cleanup-worker`, `revoke-public-connect` T3.

## D5 — Unit tests
A shared builder for the real nested adapter error shape (`src/__tests__/helpers/database-guard-error.ts`)
is used by the route tests and the parser tests. `api-error-codes.test.ts`'s code count moves to 206.

## D6 — New integration file
`team-key-recipient-binding.integration.test.ts`, 44 cells, every Testing-strategy bullet. The
rotate-key 409 cell drives the full sequence through real code (rotate-key/data GET → vault reset →
vault setup route → confirm-key redistribution → rotate POST). Passed three runs in a row on the
worktree database, and once on a freshly migrated empty database with CI's grants (VE3:
`scratchpad/ve3/empty-run.sh`, 44/44).

## D7 — VE3 CI RLS sequence
On a fresh database migrated from this branch: grants, migrate deploy, smoke seed/verify,
cross-tenant seed, coverage, verify and the negative test all exit 0. With the
`team_key_recipient_guard` allowlist lines removed, verify fails `[E-RLS-BYPASS-ROUTINE] routines set
an app.bypass_* setting: team_key_recipient_guard()`. `audit-db-grants` on that scratch database
fails only on its own role bootstrap (database ACLs, `tenant_claim_events` column grants); no line
names a table or routine of this change. CI's audit job is the authoritative run.

## D8 — Docs
`docs/security/cryptography-whitepaper.md` (key distribution records the recipient fingerprint;
6.1.e notes a future compromise-rotation mode must clear rows first) and CLAUDE.md's member-key row
(GET only, FN3).

## D9 — Red-proofs
- The #1074 runner (`scripts/manual-tests/departed-member-guard-redproof.sh`) now takes
  `REDPROOF_SET` (a second row set) and a per-row `function` file naming the migration and the guard
  function a `function.patch` applies to; the extract is byte-identical for `departed_member_guard`.
  `check-bypass-rls`'s allowlist entry for the runner is file-level, since the routine is a variable.
- `scripts/manual-tests/team-key-recipient-guard-redproof/rows/`: rows 1–22 (with 11a/11b, 13b, 20b)
  all prove. Rows 08, 11a and 21 go red earlier than the plan's named assertion (the lock witness;
  enforce-mode RLS refusing the leaked bypass on the same INSERT; the C9 block's own
  `RLS_BYPASS_NOT_GRANTED`), each caused by the mutation. Rows 07, 20 and 20b carry `-` tokens because
  the failure diff is truncated.
- Rows 12 and 13a run through `rls-cross-tenant-verify.sql` on a fresh database: widening either
  function's bypass tables and removing C2's `SET search_path` each fail verify with
  `[E-RLS-BYPASS-ROUTINE]`; restored, verify is green.
- #1074 regression rows 01, 27 and R1y prove; R1y's `expected` gains as collateral the new unit cell
  that pins the `key_inactive` mapping ahead of this change's 409.

## D10 — /simplify
The two integration files' local `armOf` copies became one shared `guardArmOf(error, guard)` in
`src/__tests__/db-integration/helpers.ts`, kept independent of the production `databaseGuardArm` so
the tests do not check the parser with itself. The new file's two copies of the outcome chain
became `outcomeOf`. The `actual=` texts the red-proof rows match are unchanged. The #1074 rows 31a
and 31b (`source.patch` over `helpers.ts`) have their hunk headers refreshed.
