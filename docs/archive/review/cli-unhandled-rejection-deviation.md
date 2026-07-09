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

## R42 member-set expansion (Phase 2 self-R-check, security expert)

- Deviation from locked plan: C2 was planned as an unlock-only fix. The Phase 2
  self-R-check derived the actual class member-set from the defining primitive
  (production `readPassphrase(` call sites) → 3 members: unlock.ts (seed),
  agent.ts:162 (`agent --eval`, TTY, vault locked: autoUnlockIfNeeded does no API
  call → prompt before any login check), agent-decrypt.ts:283 (`agent --decrypt`
  parent path: prompts directly). The testing self-R-check initially disputed this
  (claimed apiRequest runs first); orchestrator adjudicated by reading both files —
  the disputed apiRequest sites are in loadSshKeys()/socket handlers that run AFTER
  the prompt. Security expert's finding confirmed.
- Fix applied in-phase per R42 Critical/Major disposition + R34 auth-flow carve-out
  + 30-minute rule: `assertLoggedIn()` added before both prompts; mock factories for
  api-client.js extended in agent.test.ts / agent-decrypt.test.ts /
  agent-decrypt-ipc.test.ts (R19); ordering tests added last-in-describe with
  mockImplementationOnce (same T6/T7 discipline as unlock).
- RT7 red-proof: removed both `assertLoggedIn()` calls (scratchpad backup) →
  both new tests failed fast on assertion (readPassphrase mocked — no hang shape);
  restored byte-identical (diff-verified). Full suite 311/311 green after restore.
- Behavior note: agent-decrypt's not-logged-in error now renders via C1
  (`✗ message`, exit 1) instead of that file's local `process.stderr.write` style —
  consistent with the PR's error contract.
