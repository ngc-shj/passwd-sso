# Code Review: team-item-key-id-check
Date: 2026-11-20
Review round: 1

## Changes from Previous Round
Initial review. It runs on top of the Phase 2 self-R-check, whose fixes are in the second commit:
- A10 now runs M1's own statements.
- SQLSTATE constant.
- The backfill cell normalises residue.
- Comments that described a v1+ entry without an id as a live shape.

## Functionality Findings

### F1 [Major] A stale label with version evidence is left non-pending
- **What 0.4.77 did:** a history restore of a v0 row left (v0, X). A later upgrade PUT then wrote
  (v1, X) with a fresh wrap and kept the marker.
- **Why step 4 missed it:** the entry's history holds no row with the entry's wrap, so H(e) is
  empty and step 4 left the entry alone.
- **Effect:** X now names an ItemKey the entry no longer holds, yet the entry is not pending.
- **Evidence the block can use:** in 0.5.0 an id names one `item_key_version`. So a history row,
  or an attachment CEK, carrying the entry's id at another version proves the label stale.

### F2 [Minor] The NOTICE reaches the server log only below the default `log_min_messages`
`docs/operations/deployment.md` and the M1 header said the NOTICE counts appear in the server log.

### F3 [Minor] The Migration Compatibility Rules list did not name the new `ADD CHECK` kind

### F4 [Minor] The skip-0.5.0 consequence omitted 0.4.x history restores

## Security Findings

### S1 [Minor] [Adjacent] Stale-restore subclass left out of the repair: marker above the wrap's team key version
- **What 0.4.77 did:** a restore of an older wrap kept the marker, which leaves
  `item_key_team_key_version > team_key_version`.
- **Why it is decidable:** no 0.5.0 writer produces that state.
- **Effect:** the entry is stuck, and fails closed:
  - edits are refused with `ENTRY_REKEY_REQUIRED`;
  - the re-key POST is refused with `REKEY_NOT_PENDING`.
- **Doc claim:** `deployment.md`'s "cannot be detected" claim was too broad. escalate: false.

Verified without a finding:
- **The bypass grant is minimal.** Its GUCs are transaction-local, restored before the ALTERs, and
  discarded on abort.
- **Triggers return early under the bypass.**
- **The ItemKey id is not bound into any AAD.** The repair touches no wrap or blob.
- **Adoption needs a 5-column wrap equality on the same entry.**
- **The marker only moves toward pending, and the high-water only rises.**
- **Lock order cannot deadlock with the app's order.**
- **The NOTICE carries counts only.**

## Testing Findings

### T1 [Major] Wrap equality is pinned only at step 2
- **What survives:** the 3-column and `IS NOT DISTINCT FROM` mutations of steps 4 and 6 pass
  every cell.
- **Why:** no seed at those steps differs from an equal wrap in only one column, or has a NULL
  column.

### T2 [Minor] The `REPAIRED_ROLLOUT_ENTRY.highWater` drift guard never meets the attachments term
No `MINTED` entry has an attachment.

### T3 [Minor] The plan's Implementation Checklist left implemented items unticked

### Seed Finding Disposition (testing)
- **Double `held.release()`:** rejected. `holdRowLock`'s `release()` is idempotent
  (`race-helpers.ts`).
- **A unit test for `REPAIRED_ROLLOUT_ENTRY.highWater`:** rejected as framed. The gap it pointed
  at is kept as T2.

## Adjacent Findings
S1 (security → functionality): merged with F1 into one change to step 4.

## Quality Warnings
None.

## Recurring Issue Check
Each expert's full R/RS/RT status list is in its raw output.
- **Fired:**
  - R3: F3 in functionality; T1 in testing, where the equality was propagated to 1 of 3 sites.
  - R29: F2 and S1.
  - R42: F1 in functionality; T1 in testing.
  - RT7: T1 and T2.
- **Every other rule:** OK or N/A.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1.

## Resolution Status
### F1 [Major] + S1 [Minor] Decidable stale labels
- **Action:** step 4 widened. Every arm sets marker 0, keeps the id and relabels nothing. Each arm
  is counted in `stale_pending`.
  - **(a)** marker > `GREATEST(team_key_version, 1)`, for any version;
  - **(c)** for a v1+ entry with an id and a marker above 0:
    - a history row with the entry's id at another `item_key_version`, or
    - an attachment whose `cek_item_key_id` is the entry's id at another `cek_key_version`.
- **Writer invariants it rests on:** each was checked against every 0.5.0 writer.
  - The marker is the wrap's version on create and re-key. It is kept on a same-id restore, whose
    wraps are at or after it, and set to 0 on any other restore. Rotation raises only the wrap's
    version.
  - Create, upgrade and re-key mint a new id.
  - Upload, migrate and re-key bind `cek_item_key_id` and `cek_key_version` to the entry's id
    and version.
  - No migration writes `cek_item_key_id`.
- **Docs updated:**
  - the M1 header (items 4a–4c);
  - plan D-a, D-b and SC1;
  - the `deployment.md` rollout paragraph, which now limits "cannot be detected" to a restore at
    the same versions and adds that such an entry may open while its attachments do not.
- **Modified files:** `prisma/migrations/20261120000000_team_item_key_id_check/migration.sql`
  (step 4), `docs/archive/review/team-item-key-id-check-plan.md`, `docs/operations/deployment.md`.

### F2, F3, F4 [Minor]
- **Action:**
  - `deployment.md` now states the `log_min_messages` condition and names the re-key counts as the
    signal;
  - the compatibility-rules list names `ADD CHECK`;
  - the skip consequence now includes history restores;
  - the M1 header's NOTICE sentence now matches.
- **Modified files:** `docs/operations/deployment.md`,
  `prisma/migrations/20261120000000_team_item_key_id_check/migration.sql`.

### T3 [Minor]
- **Action:** the checklist items are ticked.
- **Modified file:** `docs/archive/review/team-item-key-id-check-plan.md`.

### T1 [Major] + T2 [Minor]
- Action: the backfill cell seeds wrap controls for steps 4(b) and 6 that differ from an equal
  wrap only in `team_key_version`, only in `item_key_version`, or by a NULL `item_key_auth_tag`.
  It also gives a minted entry a mode-0 attachment and one above its other terms, and seeds the
  new step-4 arms with their allow twins. Each wrap-equality mutation at steps 4 and 6 now fails
  the cell (deviation D9).
- Modified file: `src/__tests__/db-integration/team-item-key-id-check.integration.test.ts`
