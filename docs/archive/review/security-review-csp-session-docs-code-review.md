# Code Review: security-review-csp-session-docs
Date: 2026-04-05
Review rounds: 1

## Changes from Previous Round
Initial review.

## Functionality Findings
No Critical or Major findings.

[Minor F1] `output.info` remains on stdout while `warn` moved to stderr — no unified
stdout/stderr separation policy defined. Acceptable: `info` is informational output, not
diagnostic. Out of scope for this PR.

## Security Findings
[Minor S1] Warning message "the passphrase is visible to child processes" was technically
inaccurate: `run.ts:112` strips `PSSO_PASSPHRASE` from child process env. The real risk is
the parent process environment being readable (e.g., `/proc/<pid>/environ` on Linux).
→ **Fixed**: message changed to "readable from the process environment".

## Testing Findings
[Minor T1] `output.warn` stderr routing (`console.log` → `console.error`) not verified by a
direct test. `output.test.ts` only tests `masked()`. Acceptable: the implementation is a
one-line change and fully mocked in all call-site tests.

[Minor T2] Warn assertion uses `expect.stringContaining("PSSO_PASSPHRASE")` only — cannot
detect degradation of warning content. Acceptable: the message text is stable and not
user-contract.

[Minor T3] "Already unlocked + PSSO_PASSPHRASE set" combination not tested explicitly.
The early return before the env check makes this unreachable in practice. Acceptable.

## Adjacent Findings
None.

## Quality Warnings
None.

## Resolution Status

### [S1] Minor: Warning message inaccuracy
- Action: Changed "visible to child processes" → "readable from the process environment"
- Modified files: `cli/src/commands/unlock.ts`, `README.md`
