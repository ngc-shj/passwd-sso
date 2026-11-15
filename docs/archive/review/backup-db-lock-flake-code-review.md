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

---

# Code Review: backup-db-lock-flake — Round 2
Date: 2026-11-16
Review round: 2

## Changes from Previous Round
Round-1 fixes (69df13cb9) reviewed incrementally: F1, F2, S1, S2, T1 verified resolved
by the respective experts.

## Functionality Findings
- **F3 Minor (new)** — the S2 own-failure arm read "directory present, no pid" as this
  run's own failure, but a racer part-way through its `rm -rf` (pid unlinked, host
  still there) or a third run's fresh empty lock produces the same state; contention
  was reported as INTERNAL with an `rm -rf` hint (R43: the LOCKED set shrank).

## Security Findings
- **S3 Minor (new)** — the own-failure arm's recovery hint was `rm -rf`, wider than its
  own condition (an empty lock); in the uutils release-race window it could direct an
  operator at a lock claimed since.

## Testing Findings
- **T2-1 Minor** — the bash -x cell had no positive control that xtrace is live at the claim.
- **T2-2 Minor** — the own-failure arm's "directory gone" and dangling-pid cases were unpinned.
- **T2-3 Minor** — stale-lock cell title/comment still claimed simultaneity; dead slow-dump stub.
- **T2-4 Minor** — `unclaimableLockStub` duplicated the preceding cell's inline stub.
- **T2-5 Minor** — bash -x cell could exceed spawnSync's 1 MiB default buffer on mount-heavy hosts.

## Recurring Issue Check
### Functionality expert
- R1-R2: clean · R3: clean · R4-R15: N/A · R16: clean · R17-R28: N/A · R29: clean · R30: N/A · R31: clean · R32-R33: N/A · R34: clean · R35: N/A · R36-R37: clean · R38: F3 (fails closed) · R39-R41: N/A · R42: clean · R43: F3 · R44: clean · R45-R46: N/A · R47-R51: clean · R52-R54: N/A · R55: clean · R56-R57: N/A

### Security expert
- R1-R30: N/A · R31: S3 (advisory text only) · R32-R37: N/A/clean · R38: clean · R39-R42: N/A · R43: clean · R44-R48: N/A · R49: clean · R50: clean · R51: clean · R52-R57: N/A
- RS1-RS3: N/A · RS4: clean · RS5-RS6: N/A

### Testing expert
- R1: T2-4 · R2-R15: N/A · R16: clean · R17-R28: N/A · R29: clean · R30-R41: N/A · R42: T2-2 · R43-R48: N/A · R49: T2-3 · R50: clean · R51-R57: N/A
- RT1: clean · RT2: clean · RT3: N/A · RT4: clean · RT5: clean · RT6: N/A · RT7: clean · RT8: T2-1 · RT9: N/A · RT10: T2-5 · RT11: clean

## Resolution Status
### F3 Minor contention misread as own failure
- Action: the claim runs with `LC_ALL=C` (probe: under `LC_ALL=ja_JP.UTF-8` the wording is English only with the in-subshell assignment) and the arm is entered only when the claim's errno is neither EEXIST ("cannot overwrite existing file") nor ENOENT. New cell: EEXIST claim, rmdir stub that unlinks the racer's pid and fails → LOCKED; run under C and under a translated locale when the host has one. Mutants m12 (no errno gate) and m14 (no C locale, caught by the translated-locale run).
- Modified file: scripts/backup-db.sh (claim, claim-failure arm), scripts/__tests__/backup-db.test.mjs

### S3 Minor rm -rf hint wider than the arm's condition
- Action: hint is `rmdir`, which refuses a lock claimed since; the cell asserts it. Mutant m13.
- Modified file: scripts/backup-db.sh, scripts/__tests__/backup-db.test.mjs

### T2-1 Minor xtrace positive control
- Action: the cell asserts a `+ rmdir -- …/.lock.d` trace line before reading the BACKUP_ERR line.

### T2-2 Minor unpinned arm conditions
- Action: cells for "lock gone by the time rmdir fails" (LOCKED; mutant m15 drops `[ -d ]`) and "dangling pid symlink" (EEXIST → LOCKED; with the errno gate the `! -L` test is defensive only and is pinned end to end by this cell).

### T2-3 Minor stale-lock cell overclaim
- Action: renamed "refuses to reclaim a stale lock; neither of two runs takes it"; dead slow-dump stub removed, comment states timing does not matter.

### T2-4 Minor duplicated stub
- Action: `unclaimableLockStub` moved above and used by all three claim-failure cells.

### T2-5 Minor maxBuffer
- Action: `maxBuffer: 16 MiB` on the bash -x spawn.

Mutation sweep after round 2 (concurrency describe, scratch copies via BACKUP_DB_SCRIPT):
fixed 26/26 green; m10, m11, m12, m13, m14, m15 each red on exactly their target cell;
m0 (pre-fix) red on 10 cells.

---

# Code Review: backup-db-lock-flake — Round 3
Date: 2026-11-16
Review round: 3

## Changes from Previous Round
Round-2 fixes (acdcefee9): errno-gated own-failure arm under LC_ALL=C, rmdir hint, and
the T2 test fixes. Functionality and security verified F3/S3 resolved and returned No
findings (functionality probed the wording for EEXIST incl. a dangling symlink,
ENOENT, EISDIR under ja/de locales and LANGUAGE overrides; security confirmed both
wording-mismatch directions fail closed).

## Functionality Findings
No findings.

## Security Findings
No findings.

## Testing Findings
- **T3-1 Minor** — the translated-locale cell was picked from `locale -a` by name, not
  by whether bash translates; on the stock CI runner it disappeared silently, so m14 is
  never exercised in CI and nothing said so.
- **T3-2 Minor** — the ENOENT alternative of the errno gate was unpinned (m16 survived).
- **T3-3 Minor** — the pid-gone cell did not assert it reached the state it describes.

## Recurring Issue Check
### Functionality expert
- R1-R3: clean · R4-R15: N/A · R16: clean · R17-R28: N/A · R29: clean · R30: N/A · R31: clean · R32-R33: N/A · R34: clean · R35: N/A · R36-R37: clean · R38: clean · R39-R41: N/A · R42: clean · R43: clean · R44: clean · R45-R46: N/A · R47-R51: clean · R52-R54: N/A · R55: clean · R56-R57: N/A

### Security expert
- R1-R30: N/A · R31: clean · R32-R37: N/A/clean · R38: clean · R39-R42: N/A · R43: clean · R44-R46: N/A · R47: clean · R48: N/A · R49-R51: clean · R52-R57: N/A
- RS1-RS3: N/A · RS4: clean · RS5-RS6: N/A

### Testing expert
- R1: clean · R2-R15: N/A · R16: clean · R17-R28: N/A · R29: clean · R30-R41: N/A · R42: T3-2 · R43-R48: N/A · R49: clean · R50: T3-1 · R51-R57: N/A
- RT1-RT2: clean · RT3: N/A · RT4-RT5: clean · RT6: N/A · RT7: T3-2 · RT8: T3-1, T3-3 · RT9: N/A · RT10-RT11: clean

## Resolution Status
### T3-1 Minor translated-locale selection
- Action: the locale is accepted only if bash, run under it, words neither error in English; the translated cells are always declared under a stable title and `it.skipIf` when none exists. Simulated stock-runner locale list (C, C.utf8, POSIX, en_US.utf8): cell count unchanged (252), the C cells pass, the translated ones report as skipped.
- Recorded limit: m14 (dropping LC_ALL=C) is caught only on hosts with a translating locale (this dev host: de_DE.utf8); CI provisioning is not changed in this PR. On a host without a translation the pin has nothing to correct, so the gap is coverage, not behaviour.

### T3-2 Minor ENOENT alternative unpinned
- Action: contention shapes parametrised — EEXIST (racer's pid unlinked before rmdir) and ENOENT (lock released before the claim; a third run's fresh empty lock recreated by the rmdir stub). Mutant m16 (drop the ENOENT pattern) reddens exactly the two ENOENT cells.

### T3-3 Minor state positive control
- Action: every contention-shape cell asserts the lock is present and has no pid after the run before asserting LOCKED.

Sweep after round 3: fixed 28/28 (concurrency describe); m12 red on all four shape cells; m14 red on the two translated cells; m16 red on the two ENOENT cells.

## Tightening-only skip — Round 3
Findings applied directly (no Round 4 review):
- [T3-1] [Minor] translated-locale selection/visibility — scripts/__tests__/backup-db.test.mjs — applied
- [T3-2] [Minor] ENOENT gate cell — scripts/__tests__/backup-db.test.mjs — applied
- [T3-3] [Minor] state assertions — scripts/__tests__/backup-db.test.mjs — applied
Justification: all three are test-only, inside the Round-2 fix scope (the contention
cells added in acdcefee9), change no production behaviour, and touch no security
boundary; each was red-proven by a mutant (m12/m14/m16) or by its own positive control.
Note: they add test cells rather than reword text, so "inline minor" is read as
"no observable product behaviour change" here — recorded so the call can be checked.
