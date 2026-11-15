# Code Review: backup-db-lock-flake
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review (incremental on the Phase 2 self-R-check, whose one finding — the
ordering clauses enforced by no gate — was fixed in 3f13385a0 with a source-level
order cell, red-proven by m5 and m9). Local LLM seeds unavailable (Ollama down); all
three experts reviewed the full diff.

## Functionality Findings
- **F1 Minor** — `scripts/__tests__/backup-db.test.mjs` stale-lock cell: title "lets
  exactly one of two runs reclaim the same stale lock" and the comment "The claim is a
  rename now" contradict its assertions (no run reclaims) and the script. Pre-existing
  in a changed file (R29).
- **F2 Minor** — `src/__tests__/db-integration/audit-chain-verify-worker-rls.integration.test.ts`:
  the "exited before a heartbeat" rejection interpolates piped stdout on `"exit"` — a
  member of the D7 class left out.

## Security Findings
- **S1 Minor** — `scripts/backup-db.sh` claim capture: under `bash -x` the subshell's
  trace lines are captured into `claim_err`, so the INTERNAL BACKUP_ERR line spans
  several physical lines and the cause is no longer on it. No credential can reach it
  (the passfile is created after the lock).
- **S2 Minor** — claim and `rmdir` both failing for a non-race reason (EROFS, EIO,
  EBUSY, missing `rmdir`) was reported as LOCKED "claimed at the same moment", dropping
  `claim_err` and leaving an empty lock every later run refuses. Fails closed.

## Testing Findings
- **T1 Minor** — the barrier forced both runs to arrive at the lock's mkdir together,
  but not the winner to hold the lock until the loser's mkdir had run; a winner that
  claimed, dumped and released first would make both publish with every overlap
  assertion green (R49: "forced" overclaimed).

## Adjacent Findings
- F1, F2 tagged adjacent to testing; S2 adjacent to functionality. Handled above.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R1: clean (reuses assert_root_unchanged, fail, assert_mode_private, stub/run) · R2: clean · R3: clean except F2 · R4-R15: N/A · R16: clean · R17-R28: N/A · R29: F1 · R30: N/A · R31: clean · R32: N/A · R33: N/A · R34: clean (F1 reported) · R35: N/A · R36: clean · R37: clean · R38: clean · R39-R41: N/A · R42: F2 · R43: N/A · R44: clean · R45-R46: N/A · R47: clean · R48: clean · R49: clean · R50: clean · R51: clean · R52-R54: N/A · R55: clean · R56-R57: N/A

### Security expert
- R1-R30: N/A · R31: clean · R32-R37: N/A/clean · R38: S2 (fails closed) · R39-R48: N/A · R49: clean · R50: N/A · R51: clean · R52-R57: N/A
- RS1-RS3: N/A · RS4: clean · RS5: N/A · RS6: N/A

### Testing expert
- R1-R15: N/A · R16: clean · R17-R28: N/A · R29: clean · R30-R41: N/A · R42: clean · R43-R46: N/A · R47: clean · R48: N/A · R49: T1 · R50: clean · R51-R57: N/A
- RT1: clean · RT2: clean · RT3: N/A · RT4: T1 · RT5: clean · RT6: N/A · RT7: clean · RT8: clean · RT9: N/A · RT10: clean · RT11: clean

## Environment Verification Report
- E1 (uutils on CI): emulation cell `verified-local`; real uutils through the
  host-mkdir barrier cell is `verified-CI` once this PR's run on ubuntu-26.04 is green
  (D6 records why the local real-uutils run did not happen).
- E2 (Group B needs the primary compose project): 6 Group B cells fail from this
  worktree for environment reasons; with `COMPOSE_PROJECT_NAME=passwd-sso` 5 pass and
  the delegating-stub cell fails at `service "db" is not running` — past the lock, in
  validation (`blocked-deferred`, environment-only; unchanged by this branch).
- E3 (macOS bash 3.2): `blocked-deferred` — no macOS host; recorded in C1.

## Resolution Status
### F1 Minor stale-lock cell name/comment
- Action: renamed to "refuses to reclaim a stale lock, even when two runs see it at once"; comment states the current contract.
- Modified file: scripts/__tests__/backup-db.test.mjs (stale-lock cell)

### F2 Minor remaining "exit" diagnostic
- Action: the pre-heartbeat rejection now listens on "close".
- Modified file: src/__tests__/db-integration/audit-chain-verify-worker-rls.integration.test.ts

### S1 Minor xtrace folded into claim_err
- Action: `{ set +x; } 2>/dev/null` inside the claim subshell (the script's existing idiom); new cell runs the claim-failure case under `bash -x` and asserts the BACKUP_ERR line itself carries the cause. Mutant m10 (drop the set +x).
- Modified file: scripts/backup-db.sh (claim), scripts/__tests__/backup-db.test.mjs

### S2 Minor non-race failure reported as a race
- Action: after a failed rmdir, a lock directory still present with no pid is reported as INTERNAL with the cause and the `rm -rf` recovery; pid present or directory gone stays LOCKED. Advisory read only — rmdir remains the only removal. New cell stubs `rmdir` to fail; mutant m11 (arm disabled).
- Modified file: scripts/backup-db.sh (claim-failure arm), scripts/__tests__/backup-db.test.mjs

### T1 Minor overlap not held past the loser's mkdir
- Action: a second two-party barrier after the real mkdir (both mkdirs return before either run proceeds); arrivals, timeout and seen-on-leaving asserted for both barriers.
- Modified file: scripts/__tests__/backup-db.test.mjs (contendedLockRun, expectForcedOverlap)
