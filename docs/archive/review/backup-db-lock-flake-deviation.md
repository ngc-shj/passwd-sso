# Coding Deviation Log: backup-db-lock-flake

## D1 — Implemented directly, not through Sonnet sub-agents (Step 2-2)
- Two files whose edits depend on each other line-for-line (the claim's exact error
  wording is asserted by the cells), roughly 60 lines of script and 200 of test. Split
  batches would have had to share the same strings; the review rounds were the
  independent check.

## D2 — Implementation overlapped plan-review Round 2
- The C1/C2 code and the cells were written while the Round-2 experts were reading the
  plan; they reviewed the plan against that working tree. Their findings (F-F7..F-F9,
  S2-F1, T2-F1..T2-F4) were applied to both plan and code.

## D3 — Claim error appended to the INTERNAL message (F-F9)
- Not in the round-1 plan: `claim_err` captures the noclobber claim's stderr and the
  INTERNAL arm appends it. The LOCKED arm does not print it.

## D4 — `run()` gained a `killSignal` option (T2-F1)
- Test helper change outside the planned cells; default behaviour unchanged.

## D5 — Mutation "RUN_PARTIAL never assigned" dropped from the red-proof sweep
- Without the assignment every run fails at the manifest write, so the mutant reddens
  the whole file and discriminates nothing; the two clauses it stood for are covered by
  m5 (assigned before mkdir) and m8 (assigned after the mode check).

## D6 — Real-uutils end-to-end reproduction not run locally (E1)
- The harness run with the uutils 0.8.0 binary was refused twice by the session's
  permission layer. Evidence instead: the primitive probe (5/30 vs 0/30), the upstream
  fix commit, CI's error wording, and the deterministic emulation cell; this PR's CI run
  on ubuntu-26.04 exercises the barrier cell against real uutils.
