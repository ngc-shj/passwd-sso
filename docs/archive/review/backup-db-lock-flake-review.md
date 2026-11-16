# Plan Review: backup-db-lock-flake
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening skipped (Ollama unavailable).

## Functionality Findings
- **F-F1 Major (design)** — claim failure classified by `[ -f pid ]` then `rm -rf`: R51 gap;
  EEXIST/ENOENT contention misrouted to INTERNAL; can remove a third run's lock.
  → **Resolved**: C1 rollback adjudicated by `rmdir` (success ⇒ INTERNAL, failure ⇒ LOCKED).
- **F-F2 Minor** — reused rollback referenced `$LOCK_DIR`, empty at claim failure. → **Resolved** (C1 names `$LOCK_CANDIDATE`, separate from the post-claim rollback).
- **F-F3 Minor (prose)** — C5/R42 missed the rollback comment, the Publish INV-C4e
  comment and the `.partial` mkdir member; R-3 holds for cooperating runs only. → **Resolved** (C5, member set, R-3 reworded, C2 residual).
- **F-F4 Minor** — claim needs `2>/dev/null`. → **Resolved**.
- **F-F5 Minor (question)** — bash 3.2 O_EXCL not re-derived. → **Recorded** as E3 (`blocked-deferred`, no macOS host).
- **F-F6 [Adjacent] Major** — fixture drift (see T-F3). → **Resolved** with C4.
- Confirmed: uutils' pre-existing-path check means held/stale locks still reach the reader branch; added to Root cause.

## Security Findings
- **S-F1 Minor** — premise "uutils <0.11 succeeds for ANY existing directory": **Rejected**.
  Evidence: upstream pre-fix `create_dir` refuses an existing path first ("File exists"),
  and the probe `uutils mkdir -- <existing dir>` → rc=1. False success is confined to the
  check/create window; the reader branch still runs for held/stale locks.
- **S-F2 Minor** — rollback residual understated (ENOENT, classification TOCTOU); use rmdir. → **Resolved** (same as F-F1).
- **S-F3 Minor** — `.partial` ownership still trusts mkdir(1). → **Accepted**, see below.
- **S-F4 Minor** — `RUN_PARTIAL` must precede `assert_mode_private`. → **Resolved** (C2).
- **S-F5 Minor (prose)** — noclobber is O_EXCL only when `pid` is absent. → **Resolved** (C1 precondition stated).

### S-F3 Minor `.partial` ownership trusts mkdir(1) — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a run adopts a `.partial` another writer created in the same microsecond window and removes or renames it on failure.
  - Likelihood: low — requires a second writer choosing the same stamp under the same root at the same time; a same-host writer needs the C1 lock to have failed (now kernel-adjudicated), a different host is refused by the `host` check.
  - Cost to fix: an owner marker inside the `.partial` is published with the generation (or needs a rename step at publish, a new failure surface) — ~1–2 h plus format change, without a reachable trigger.
- **Orchestrator sign-off**: acceptable-risk exception satisfied; residual recorded in C2.

## Testing Findings
- **T-F1 Major** — timeout-marker absence alone does not prove overlap. → **Resolved** (arrival count == 2 asserted first).
- **T-F2 Major** — uutils emulation lacked the pre-check; needs scope and a fired marker. → **Resolved** (C3).
- **T-F3 Major** — post-claim rollback untested once 2242 moves to the claim arm. → **Resolved** (`/dev/full` cell; 2242 retargeted to chmod 0500; injections probed under bash: devfull claim rc=0 then write rc=1; 0500 claim rc=1, rmdir rc=0; regular pid claim rc=1, rmdir rc=1).
- **T-F4 Major (prose)** — allow-side cited a cell without a `.partial` assertion. → **Resolved** (assertion added to the dump-failure cell; `.FAILED` cell cited).
- **T-F5 Minor** — stress loop retargeted to barrier false-timeouts. → **Resolved**.
- **T-F6 Minor** — kill-on-timeout for spawned runs. → **Resolved**.
- **T-F7 Minor (prose)** — "GNU-faithful" → host mkdir; CI is real-uutils evidence. → **Resolved**.
- **T-F8 Minor** — old FREE-lock cell subsumed. → **Resolved** (removed).
- **T-F9 Minor** — deterministic regular-pid → LOCKED cell. → **Resolved**.

## Adjacent Findings
- F-F6 (→ testing): merged into T-F3.
- T-F3 adjacent (→ functionality/security): a non-regular openable `pid` counts as a claim — merged into S-F5.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R1-R28: N/A or checked — no issue (bash error paths, `set -e` in `if !` context, trap ownership checked)
- R29: uutils commit/date/issue/release verified; premise wording → F-F3; bash 3.2 → F-F5; residual text → F-F1
- R30-R41: N/A
- R42: one member missed → F-F3
- R43-R46: N/A
- R47: checked — enforceable boundary among cooperating runs
- R48: N/A
- R49: kernel O_EXCL correct; rollback should be kernel-adjudicated → F-F1
- R50: N/A
- R51: F-F1
- R52-R57: N/A

### Security expert
- R1-R28: N/A
- R29: checked
- R30: N/A
- R31: applied — trap lock removal gated on pid==$$; rollback (S-F2); RUN_PARTIAL (S-F3/S-F4)
- R32-R37: N/A
- R38: S-F1 (rejected, see above)
- R39-R41: N/A
- R42: S-F3
- R43-R46: N/A
- R47: checked
- R48: N/A
- R49: checked
- R50: N/A
- R51: S-F2, S-F5
- R52-R57: N/A
- RS1: N/A · RS2: N/A · RS3: checked (passfile only under the lock) · RS4: N/A · RS5: checked (fails closed except S-F2) · RS6: N/A

### Testing expert
- R1-R57: outside testing scope except R42 (member set agrees: mkdir at BACKUP_DIR / lock / .partial)
- RT1: T-F2 · RT2: T-F1, T-F4 · RT3: checked · RT4: T-F1, T-F2, T-F9 · RT5: T-F5 · RT6: T-F4 · RT7: T-F3 + mutation table · RT8: checked; T-F7 · RT9: T-F1 · RT10: T-F4, T-F9 · RT11: T-F6

---

# Plan Review: backup-db-lock-flake — Round 2
Date: 2026-11-16
Review round: 2

## Changes from Previous Round
Claim failure adjudicated by `rmdir` (round-1 F-F1/S-F2); `RUN_PARTIAL` assigned right
after its mkdir; barrier/positive-control/uutils-model test design; S-F1 rejected with
evidence; S-F3 accepted. The C1/C2 code and the round-2 cells were already in the
working tree when the experts read it.

## Functionality Findings
- **F-F7 Minor (prose)** — plan said "no userland check" between claim and rmdir; `assert_root_unchanged` sits there. → **Resolved** (C1 reworded; its PRUNE_ABORTED arm stated).
- **F-F8 Minor (design)** — rmdir success can remove a newer run's empty `.lock.d` (ABA), misreporting contention as INTERNAL; R-1 intact. → **Accepted**, recorded as a C1 residual; script comment softened to "the directory now at that path".
- **F-F9 Minor (design)** — INTERNAL arm discarded the claim's errno. → **Resolved**: the claim's stderr is captured and appended to the INTERNAL message only; the chmod-0500 cell asserts `Permission denied`.

### F-F8 Minor rmdir ABA misclassification — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a run reports `INTERNAL` instead of `LOCKED` for a contention event; no run proceeds, nothing is removed that holds a claim.
  - Likelihood: low — needs a uutils false-success `mkdir`, a post-claim rollback (ENOSPC after a successful claim) by the winner, and a third run's `mkdir` all inside the loser's claim→rmdir window (microseconds).
  - Cost to fix: distinguishing it needs an identity check on the directory (inode captured at mkdir time), i.e. a `stat` between mkdir and claim plus a second adjudicator — more surface than the mislabel it prevents.
- **Orchestrator sign-off**: acceptable-risk exception satisfied; residual recorded in C1.

## Security Findings
- **S2-F1 Minor (prose)** — C1 named the kernel as adjudicator while the script reads `rmdir(1)`'s status; misreports are safe but undocumented; `rmdir(1)` missing from the member set. → **Resolved** (C1 states both misreport directions fail closed; member set notes the read).
- Verified: the round-1 TOCTOU is closed; the C1 precondition wording matches bash `noclobber_open`; the test seams (`/dev/full`, `chmod 0500`) need the owner's uid in an audited 0700 root.

## Testing Findings
- **T2-F1 Major (design)** — `/dev/full` cell used `run()`'s SIGTERM; under the "no post-claim rollback" mutant the trap reads `/dev/full` forever and `spawnSync` never returns. Observed: the first red-proof sweep hung on exactly that mutant and was stopped. → **Resolved**: `run()` takes `killSignal`; the cell passes `SIGKILL`.
- **T2-F2 Major (design)** — C2's "before `assert_mode_private`" clause untested. → **Resolved**: new mode-check `.partial` cell + mutation row.
- **T2-F3 Minor (design)** — arrivals == 2 does not prove a run waited. → **Resolved**: each run records the count it saw on leaving; asserted `["2","2"]`.
- **T2-F4 Minor (prose)** — `LOCK_DIR`-before-claim has no behavioural test. → **Resolved** (stated as grep-only in the plan).

## Saturation call (Round 2)
All round-2 findings are resolved in the plan/code except F-F8 (Minor, accepted with
quantification). No Critical or Major finding is open; no open finding is against the
design. Plan review exits at round 2.

## Recurring Issue Check
### Functionality expert
- R1-R28: checked where applicable (`set -e` in `if`, trap ownership with empty LOCK_DIR, RUN_PARTIAL ordering)
- R29: checked · R30-R41: N/A · R42: checked · R43-R46: N/A · R47: checked · R48: N/A · R49: checked; residual F-F8 · R50: N/A · R51: F-F7, F-F8 · R52-R57: N/A

### Security expert
- R1-R28: N/A · R29: checked · R30: N/A · R31: checked · R32-R41: N/A · R42: S2-F1 · R43-R46: N/A · R47: checked · R48: N/A · R49: checked · R50: N/A · R51: checked; S2-F1 prose · R52-R57: N/A
- RS1-RS2: N/A · RS3: checked · RS4: N/A · RS5: checked · RS6: N/A

### Testing expert
- R1-R41: N/A · R42: checked · R43-R50: N/A · R51: checked · R52-R57: N/A
- RT1: checked · RT2: T2-F3 · RT3: checked · RT4: T2-F1, T2-F2, T2-F4 · RT5: checked · RT6: checked · RT7: T2-F2, T2-F3 · RT8: checked · RT9: T2-F3 · RT10: checked · RT11: T2-F1
