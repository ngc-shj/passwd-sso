# Plan: backup-db-lock-flake (issue #1050)

## Project context

- Type: `mixed` — a bash operator script (`scripts/backup-db.sh`) plus its vitest harness
  (`scripts/__tests__/backup-db.test.mjs`) and the operator docs.
- Test infrastructure: `unit + integration` + CI/CD (the harness spawns the real script
  against stubbed `docker`/`mkdir`/`stat`).
- Verification environment constraints:
  - **E1** — CI runs on `ubuntu-26.04` (`Image: ubuntu-26.04` in run 43589583699's log),
    whose `mkdir` is uutils coreutils; the dev host has GNU coreutils 9.4. Running the
    harness against a real uutils binary was refused by the session's permission layer
    (twice), so the uutils behaviour is emulated by a stub (C3) and the PR's own CI run
    is the real-uutils evidence (`verifiable-CI`). The primitive was probed directly: see
    Root cause.
  - **E2** — Group B cells need `pg_restore` through the primary checkout's compose
    project; from this worktree 6 Group B cells fail for environment reasons. Untouched
    by this change; full-file runs are compared against the primary checkout.
  - **E3** — macOS (`/bin/bash` 3.2) is not available here; the noclobber probe ran on
    bash 5.2 only (`blocked-deferred`, see C1).

## Objective

Make the `.lock.d` mutual exclusion hold on hosts whose `mkdir(1)` is not an atomic
claim, stop the cleanup trap removing a run directory the run did not create, and make
the contention cells force the overlap they test instead of depending on scheduling.

## Root cause

Two CI attempts of run 43589583699 failed two different cells:

- Attempt 1, "…take a FREE lock, under real contention": both runs exited 1, neither
  printed `BACKUP_ERR:LOCKED`; one printed `mkdir: <root>/20261114T112239Z.partial: File
  exists`, the other `stat: cannot statx '<…>.partial'`.
- Attempt 2, "…take a FREE lock" (no `mkdir` stub): zero winners, output not captured.

`mkdir: <path>: File exists` is not GNU's wording (`cannot create directory '<path>'`);
it is uutils'. uutils `mkdir` before upstream commit `bf423f388d` ("mkdir: do not ignore
EEXIST on non-recursive creation", fixes uutils#13970, 2026-08-28, first released in
0.11.0) first refuses a path that already exists ("File exists"), then on a failed
`mkdir(2)` takes `Err(_) if path.is_dir() => Ok(())` — without `-p`. So the false
success is confined to the window between its own existence check and its create: two
concurrent `mkdir dir` both exit 0, while a `mkdir` of a directory that already existed
still fails. The reader branch for held and stale locks is therefore still reached on
uutils hosts.

Probe (dev host, uutils 0.8.0 aarch64-musl release binary vs `/usr/bin/mkdir`), 16
concurrent `mkdir -- <same path>`, 30 rounds, rounds with more than one exit-0:

```
mkdir (uutils coreutils) 0.8.0
uutils 0.8.0: rounds with >1 winner: 5/30
GNU: rounds with >1 winner: 0/30
$ uutils mkdir -- <existing dir>   → "mkdir: <path>: File exists", rc=1
```

The `0.3 s` sleep the contention cell puts in front of the lock's `mkdir` lines both
runs up on exactly that window, so on the uutils runner both pass the acquire, pick the
same stamp, one creates `<stamp>.partial`, the other's `mkdir` of it fails, and that
loser's EXIT trap `rm -rf`s the `.partial` because `RUN_PARTIAL` was assigned before the
`mkdir` (shape 1).

Shape 2 (local, 1/80 under CPU pinning, both succeed under consecutive stamps) is the
test's: the two `spawn()`s are not guaranteed to overlap inside the sleep.

## Requirements

- R-1: exactly one concurrent run on one host proceeds past the acquire, whether or not
  `mkdir(1)` reports EEXIST faithfully.
- R-2: the lock's on-disk form is unchanged (`.lock.d/` with `pid`, `host`, `starttime`);
  the documented recovery `rm -rf <root>/.lock.d` stays correct; no `flock(1)`.
- R-3: the cleanup trap removes or keeps-as-FAILED only a `.partial` this run's `mkdir`
  reported creating. Among cooperating runs on one host that is the run's own, because
  the stamp is chosen under the lock (R-1).
- R-4: the contention cells force both runs into the acquire together, prove it, and
  fail when the overlap did not happen.
- No retries and no widened sleeps.

## Technical approach

The authoritative claim moves from `mkdir(1)`'s exit status to bash's own `noclobber`
redirection on `.lock.d/pid`. Under `set -C`, bash's `noclobber_open` (`redir.c`) stats
the target and, when it does not exist, opens it `O_CREAT|O_EXCL`, so between two runs
racing for an absent `pid` the kernel picks one. `mkdir` stays as the container's
creator and the "already held" detector; when it falsely reports success, the second
claimant's `O_EXCL` fails.

Probe (bash 5.2.21): `strace -e trace=openat bash -c 'set -C; : > x'` shows
`openat(…, "x", O_WRONLY|O_CREAT|O_EXCL, 0666)`; 16 concurrent `( set -C; : > f )` per
round, 50 rounds: 0 rounds with other than exactly one winner.

## Contracts

### C1 — lock claim (scripts/backup-db.sh, "Mutual exclusion")

- After `mkdir -- "$LOCK_CANDIDATE"` succeeds, the run claims with
  `( set -C; : > "$LOCK_CANDIDATE/pid" ) 2>/dev/null`. Only on success is `LOCK_DIR`
  assigned and `record_lock_metadata` run (it overwrites the run's own empty `pid` with
  `$$`, then `host`, `starttime`); its existing post-claim rollback (`rm -rf
  "$LOCK_DIR"`) is unchanged — the run provably owns that directory.
- Claim failure is adjudicated by `rmdir -- "$LOCK_CANDIDATE"` (after
  `assert_root_unchanged`, like every other removal under the root):
  - `rmdir` succeeds → the directory was empty, nobody had claimed it →
    `fail INTERNAL "could not record the lock holder"`. No wedge is left (rmdir needs no
    space). If a racer had passed its own false-success `mkdir` and not yet claimed, its
    claim now fails ENOENT and it reports LOCKED: both stop, neither proceeds.
  - `rmdir` fails (ENOTEMPTY: a racer's `pid` is there; ENOENT: the holder already
    released) → `fail LOCKED` naming a concurrent claim. `LOCK_DIR` stays empty, so the
    trap leaves the other lock alone.
  - No check of the lock's state sits between the failed claim and the removal (R51).
    The only check there is `assert_root_unchanged`, which re-verifies the root's
    identity; when it fails the run exits PRUNE_ABORTED and leaves the candidate in the
    replaced root (fail closed).
  - The script reads `rmdir(1)`'s exit status, while `rmdir(2)` is what decides. A
    misreport fails closed in both directions: false success → INTERNAL with the
    directory intact; false failure → LOCKED with the empty directory already gone.
  - Residual (F-F8, accepted): `rmdir` succeeding proves the directory at that path was
    unclaimed, not that this run lost no race. With a false-success `mkdir`, a winner's
    own post-claim rollback, and a third run's fresh `mkdir` all inside one window, this
    run removes the third run's empty directory and reports INTERNAL for contention;
    the third run then reports LOCKED. Nobody proceeds (R-1 holds); only the error class
    is off.
  - The INTERNAL arm appends the claim's own error text (ENOSPC vs EACCES).
- The `mkdir`-failed reader branch is unchanged.
- Control class: **enforceable boundary** among same-host runs of this script;
  adjudication authority: the kernel — `O_EXCL` for the claim, `rmdir(2)`'s emptiness
  check for the rollback (read through `rmdir(1)`, see below) — not `mkdir(1)`'s exit
  status. Cross-host exclusion is
  unchanged (the `host` check fails closed). Precondition: `O_EXCL` applies only while
  `pid` is absent; a pre-existing non-regular `pid` (device, FIFO, symlink to one) is
  opened without it. Only the owner (or root) can plant one, because the root is
  audited owner-only, 0700, ACL-free with safe ancestors before the lock is taken.
- E3: bash 3.2's `noclobber_open` is not re-derived here. `set -C` is POSIX and the
  function predates 3.x; recorded as unverified on macOS rather than claimed.
- Forbidden: `pattern: LOCK_DIR="\$LOCK_CANDIDATE"` before the noclobber claim — reason:
  ownership on `mkdir`'s word. `pattern: rm -rf -- "\$LOCK_CANDIDATE"` — reason: the
  claim-failure rollback must be emptiness-adjudicated.

### C2 — run-directory ownership (scripts/backup-db.sh, "Run directory")

- `RUN_PARTIAL` is assigned immediately after `mkdir` of `<stamp>.partial` succeeds and
  before `assert_mode_private`; before that the path lives in a variable the trap does
  not read.
- Residual (accepted): `.partial` ownership still rests on `mkdir(1)`'s exit status, so
  a foreign creator racing inside the uutils false-success window would be adopted.
  A same-host foreign creator requires R-1 to have failed; another host is refused by
  the lock's `host` check. Claiming the `.partial` with a marker would publish the
  marker or need a rename at publish — cost without a reachable trigger.
- Forbidden: `pattern: ^RUN_PARTIAL="\$BACKUP_ROOT/\$STAMP.partial"$` before the mkdir.

### C3 — tests: forced overlap (scripts/__tests__/backup-db.test.mjs)

- A helper builds a `mkdir` stub. For an argument matching `*/.lock.d` only: append an
  arrival file under `<tmpDir>/barrier/` (created with node's `mkdirSync`), wait until
  two arrivals exist (bounded at 10 s; on expiry write `<tmpDir>/barrier-timeout` and
  proceed), then exec the real `mkdir` by absolute path. Every other argument execs the
  real `mkdir` unchanged.
- Contention cells assert BEFORE the outcome assertions: arrivals == 2 (positive
  control: the barrier engaged), timeout marker absent, and each run recorded seeing 2
  arrivals when it left the barrier (arriving is not waiting; T2-F3). Each spawned run is SIGKILLed
  after 20 s (below the 30 s cell timeout) so a hung barrier cannot leak processes.
- "…take a FREE lock, under real contention": barrier in front of the host's `mkdir`
  (GNU here, uutils on CI). Exactly one exit 0, the other `BACKUP_ERR:LOCKED`, one
  generation, no `.partial`.
- New "keeps one holder when mkdir reports success for a lock another run created":
  uutils<0.11 model — existence pre-check (`File exists`, exit 1) BEFORE the barrier,
  then the barrier, then the real `mkdir`; on its failure, if the path is a directory,
  write `<tmpDir>/false-success` and exit 0. Asserts arrivals == 2, the false-success
  marker present (the emulated branch ran), exactly one exit 0, the other
  `BACKUP_ERR:LOCKED` with the concurrent-claim wording, one generation, no `.partial`.
- Old "lets exactly one of two runs take a FREE lock" (no stub, CI attempt 2) is
  removed: it cannot force overlap and the two barrier cells cover its assertions.

### C4 — tests: claim branches and `.partial` ownership

- "removes the lock it just took when it cannot record the holder" — retargeted to the
  claim-failure arm: the lock's `mkdir` stub runs the real `mkdir`, then
  `chmod 0500` on `.lock.d`, so the claim fails EACCES with the directory empty. Asserts
  `INTERNAL`, "could not record the lock holder", lock gone. Skipped when running as
  root (root ignores the mode).
- New post-claim rollback cell (Linux only): the stub makes `.lock.d/pid` a symlink to
  `/dev/full`; the claim opens the device (non-regular, no O_EXCL), the `$$` write fails
  ENOSPC, the `record_lock_metadata` rollback runs. Asserts `INTERNAL`, the message,
  lock gone. Spawned with `killSignal: "SIGKILL"` (a deleted rollback leaves the trap
  `cat`ing `/dev/full`, and bash defers its TERM handler until that substitution ends,
  so the default SIGTERM never returns; T2-F1).
- New "removes its own .partial when the run directory's mode check fails": the stub
  `chmod 0755`s the `.partial` after creating it. Asserts `DEST_UNSAFE` naming the run
  directory and no `.partial` left (C2's "before `assert_mode_private`" clause; T2-F2).
- New deterministic "regular pid → LOCKED" cell: the stub runs the real `mkdir` then
  creates an empty regular `.lock.d/pid`. Asserts `LOCKED` with the concurrent-claim
  wording and that `.lock.d/pid` still exists (no rollback).
- New "leaves a .partial it did not create": the stub, for `*.partial`, creates the
  directory with a marker file via the absolute real `mkdir`, then execs the real
  `mkdir` (EEXIST). Asserts `INTERNAL` and that the directory and marker survive.
- Paired allow side: "leaves nothing published when a dump fails…" gains
  `.partial` == [] (the trap's remove arm on an ordinary `fail`); "keeps a .FAILED
  directory when validation fails…" already pins the keep arm.

### C5 — rationale text

- Script comments that state `mkdir(1)` is the atomic primitive or exclusive: the
  "Mutual exclusion" header and acquire comment, the rollback comment ("mkdir had just
  succeeded, so nothing else holds it"), the Publish comment's INV-C4e sentence ("the
  bare mkdir of the .partial"). Docs `docs/operations/backup-recovery/{en,ja}.md`
  ("`mkdir` … which is atomic"). Each is reworded to name the noclobber claim. The
  recovery command is unchanged.

## Member set (R42)

Class: filesystem creates whose exit status is read as exclusive ownership. Derived
with `git grep -n -E 'mkdir --|if ! mkdir|\.lock\.d|LOCK_DIR=' -- scripts ':!**/__tests__/**'`
plus the script's three `mkdir` calls (`grep -n 'mkdir' scripts/backup-db.sh`):
`BACKUP_DIR` creation (not a claim), the lock (C1), the `.partial` (C2, residual
recorded). `scripts/lib/set-role-password.sh`'s `set -o noclobber` is a temp file, not a
lock. Related read: the claim-failure `rmdir(1)` exit status is read as "unclaimed";
safe because both misreport directions fail closed (C1).

## Testing strategy

Red proofs (each run with `BACKUP_DB_SCRIPT=<scratch mutant>`, one mutation per clause):

| Mutation | Must fail |
|---|---|
| pre-fix script | uutils cell, `.partial` foreign cell |
| drop `set -C` from the claim | uutils cell, regular-pid cell |
| claim failure always rolls back (no rmdir adjudication) | regular-pid cell |
| claim failure always LOCKED | chmod-0500 cell |
| delete post-claim rollback | /dev/full cell |
| `RUN_PARTIAL` assigned before the mkdir | foreign `.partial` cell |
| `RUN_PARTIAL` assigned after `assert_mode_private` | mode-check `.partial` cell |
| claim error not appended to INTERNAL | chmod-0500 cell |
| lock path renamed (barrier pattern no longer matches) | arrival-count assertion |
| barrier lets a run through on one arrival (test-side mutant) | seen-on-leaving assertion |

| `LOCK_DIR` assigned before the claim | source-level order cell |
| `RUN_PARTIAL` assigned before the mkdir | foreign `.partial` cell, source-level order cell |

`LOCK_DIR` assigned before the claim has no behavioural test (the trap's `pid == $$`
check masks it), and a diff grep cannot see position (the C1/C2 "forbidden patterns"
also match the correct lines). Both ordering clauses are therefore pinned by a
source-level cell that compares line positions in the script (self-check R49/RT7).

Stress: the barrier cells and the uutils cell, `taskset -c 0-1`, 8 parallel × 10, to
measure false barrier timeouts under load (expected 0). Then the full file, full
`npx vitest run` (Group B compared with the primary checkout, E2), `npx next build`.

## Considerations & constraints

- SC1: publish (`mv`) and prune keep relying on the lock; no other external-binary
  atomicity is read as a claim (member set).
- The barrier's 10 s bound is a synchronization bound; expiry fails the cell.

## User operation scenarios

- Ubuntu 26.04 host, timer run and manual run colliding: one proceeds, the other
  reports `BACKUP_ERR:LOCKED`.
- Run killed between claim and `pid` write: `.lock.d/pid` exists empty; the next run's
  `mkdir` fails, the reader reports "records no holder", the documented `rm -rf`
  recovers.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | noclobber claim + rmdir-adjudicated rollback | locked |
| C2 | `RUN_PARTIAL` set right after its mkdir | locked |
| C3 | barrier-forced overlap, positive control, uutils cell | locked |
| C4 | claim-branch cells, foreign `.partial`, allow side | locked |
| C5 | comments/docs stop calling mkdir(1) exclusive | locked |

## Implementation Checklist

- `scripts/backup-db.sh` — "Mutual exclusion" (claim, rmdir arm, comments), post-claim
  rollback comment, "Run directory" (`RUN_PARTIAL` after mkdir), Publish comment.
- `scripts/__tests__/backup-db.test.mjs` — `run()` `killSignal`; dump-failure `.partial`
  assertion; concurrency describe (helpers, barrier cells, uutils cell, regular-pid,
  chmod-0500, /dev/full, foreign `.partial`, mode-check `.partial`); old FREE-lock cell
  removed.
- `docs/operations/backup-recovery/{en,ja}.md` — lock paragraph.
- Reused: `assert_root_unchanged`, `fail`, `assert_mode_private`, harness `stub()`/`run()`.
- CI gate parity: the touched code is covered by the vitest job (`scripts/__tests__/**`)
  and lint; no CI-only gate reads these files (the gitleaks/static jobs read docs as text).
