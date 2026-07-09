# Coding Deviation Log: cli-unhandled-rejection

## RT7 red-proof record (AC3-3, plan I6)

- C1 revert proof: restored `program.parse()` in `cli/src/index.ts`, rebuilt dist, ran
  `cli-error-output.test.ts` → BOTH integration cases failed on the negative
  no-stack-frame assertion (`expected '...' not to contain '    at '`), exactly the
  expected red shape. Re-applied C1, rebuilt → 2/2 green.
- C2 revert proof: removed the `assertLoggedIn()` call from `unlockCommand` (backup
  copy under session scratchpad, restored byte-identical afterwards — diff-verified),
  ran `unlock.test.ts` → new ordering test failed with `Test timed out in 5000ms`
  (the plan-predicted timeout-shaped failure at readPassphrase's never-resolving
  promise). Restored → full cli suite 309/309 green.
- Mutation-residue grep over `git diff`: clean (no commented-out guards, no skip
  markers; the single `xit\(` regex hit was a false positive on `process.exit(`).
