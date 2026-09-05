# Coding Deviation Log: audit-emit-tx-fold

## Step 2-1 — CI gate parity

15 CI gates extracted. A naive `npm run <name>` key match suggested 9 gaps; each
was checked against `scripts/pre-pr.sh`'s actual invocation, which calls the
underlying script rather than the npm alias. **Seven were false gaps** — the
mechanical diff is not the measurement, which is the R29 shape this log exists to
keep honest. Two are real:

- **Deferred parity gap: `npm run licenses:check:strict` (and the `:cli` / `:ext`
  variants)** — reason: they read `package-lock.json` / the CLI and extension
  lockfiles and assert a license allowlist. `pre-pr.sh` does not run them, and
  this diff adds no dependency, so the gate's input set is unchanged by it. Run
  once in Step 2-4 to confirm, not added to `pre-pr.sh` here — extending the
  aggregate script with three license gates is a change to every future PR's cost
  and belongs to whoever owns that decision.
- **Deferred parity gap: `bash scripts/check-state-mutation-centralization.sh`** —
  reason: not in `pre-pr.sh`. This diff **does** touch `transition()` call sites
  (C0/E2 changes the `db` argument), so this gate is in scope and MUST be run
  locally in Step 2-4 rather than deferred to CI.

## Step 2-1 — carried-forward disposition

CF1, CF3, CF4, CF5 are fixed in this phase (see the Implementation Checklist).
**CF2 is dispositioned as "derived by running"**: its member set is produced by
landing C2 with I2.4's module-load assertion and reading which test files fail at
import. Revision 3's static list was wrong in both directions, so reproducing a
list here would repeat the error. The 15 candidates recorded in the checklist are
the expected superset, not the answer.
