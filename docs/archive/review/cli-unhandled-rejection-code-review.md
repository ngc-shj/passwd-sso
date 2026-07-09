# Code Review: cli-unhandled-rejection
Date: 2026-07-09
Review rounds: 3 (converged — all experts "No findings")

## Round Summary

| Round | Functionality | Security | Testing | Fix commit |
|-------|--------------|----------|---------|-----------|
| 1 | F8 Minor (daemon "Parse error:" mislabel, pre-existing in touched file) | No findings | No findings (3 seed hints rejected with evidence) | `59d087ac` |
| 2 | No findings (F8 fix verified: nesting, single-respond, shape; independent 312/312 re-run) | No findings (socket disclosure zero-delta; JSON.stringify framing safe; authz semantics unchanged, fail-closed) | No findings (once-impl consumption deterministic; no ordering hazard with T7 chains; red-proof adequate) | — |
| 2b gate | — | — | pre-pr.sh check-test-hygiene fired (whole-file scan of touched test files): direct env mutations → vi.stubEnv + `unstubEnvs: true` in cli/vitest.config.ts | `46ce45fa` |
| 3 (testing only) | — | — | No findings (6/6 stub/replace/delete interplay scenarios empirically verified incl. ambient worst case; no test relied on env leakage) | — |

## Round 1 Detail
Initial code review (on top of the Phase 2 self-R-check baseline, which had already
surfaced and fixed the R42 class expansion — agent.ts / agent-decrypt.ts
prompt-before-login — in commit `8e2eaa17`).

## Functionality Findings

[F8] Minor (new in phase 3 round 1): apiRequest rejections inside the decrypt daemon surfaced with a misleading "Parse error:" label
- File: cli/src/commands/agent-decrypt.ts (handleConnection IIFE catch; handleDecryptRequest apiRequest calls)
- Evidence: single try wrapped both JSON parsing AND `await handleDecryptRequest(...)`; catch emitted `Parse error: ${err.message}` — so `fetch failed` / `Not logged in...` mid-daemon-life read as parse failures.
- Impact: no functional break (client receives ok:false; daemon does not crash), but misleading diagnostics relayed verbatim by `decrypt`.
- Pre-existing, in-scope per Anti-Deferral (file in diff); fix under 30-minute rule.

Verification backing (no other findings): C1 byte-for-byte vs locked contract; forbidden patterns absent; R42 member-set re-derived (3 members all guarded; indirect-prompt sweep over setRawMode / rl.question / createInterface found no 4th member — login.ts prompts pre-login by design, ssh-confirm and REPL are post-unlock); guard-placement edge cases correct (TTY-check-before-guard deliberate); agent-decrypt C1 routing is a safe behavior change (old output was an unhandled-rejection stack, exit code unchanged at 1, socket clients consume the socket protocol not startup stderr); I3/I3b hold; R19 four factories aligned; build + 311/311 verified including integration cases actually executed (not skipped).

## Security Findings

No findings.

- 8e2eaa17 verified correct and complete by independent member-set re-derivation (3/3 guarded, zero delta; ssh-confirm.ts is not a member).
- Exhaustive branch walk: no remaining path prompts without login (daemon children receive keys via IPC; autoUnlock env path throws via apiRequest→assertLoggedIn to C1 without prompting; non-eval/non-TTY branches exit before the prompt).
- agent-decrypt throw→C1 is a strict stderr reduction; C1 renders via console.error (stderr) so `eval $(...)` stdout capture can never receive the error line.
- err.message surface of newly C1-routed flows: all content previously printed as line 1 of the uncaught dump; no new disclosure.
- Zeroization paths untouched; guards throw before setRawMode and before any secret exists.
- Informational (not a finding, pre-existing): assertLoggedIn checks presence, not freshness — expired-token user still prompted, then clean 401 error; passphrase used only locally.

## Testing Findings

No findings.

- All 3 ordering tests: mockImplementationOnce, last-in-describe (verified single-describe files), plan-mandated assertions.
- Integration test implements every plan mandate (closed stdin, computed timeout, skipIf, per-marker negative assertions on combined output, HOME/XDG isolation).
- RT7 red-proof records verified in deviation log for all 5 new tests with the plan-predicted red shapes.
- Cross-file isTTY leak empirically disproven (two-file probe, both parallelism modes).

## Adjacent Findings

None this round. (Phase 1's S-A1 / SC1 exit-0 class remains tracked via TODO(cli-exit-codes); untouched by this diff.)

## Quality Warnings

None (all findings carry file/line evidence and concrete fixes).

## Seed Finding Disposition (per expert)

- Functionality: Seed returned No findings — verified independently, no dispositions to record.
- Security: Seed returned No findings — verified independently, no dispositions to record.
- Testing (seed truncated — treated as unavailable; 3 hint items dispositioned):
  1. agent-decrypt.test.ts XDG_RUNTIME_DIR restoration — Rejected (existing describe-level afterEach deletes it; identical trio contract as pre-existing tests).
  2. api-client.test.ts sticky loadCredentials.mockReturnValue(null) — Rejected (behaviorally inert: null ≡ undefined for every consumer; token cache seeded in beforeEach; pattern predates diff).
  3. agent.test.ts isTTY guarded restore — Rejected as finding (stub does persist post-test, but last-in-only-describe has no in-file victim and cross-file leak empirically disproven; informational hygiene note recorded).

## Recurring Issue Check (Phase 3 Round 1 — deltas vs Phase 2 self-check baseline)

### Functionality expert
- R34: delta — fired as the basis for F8 (pre-existing flaw in diff-touched file, flagged not deferred)
- R42: delta — re-derived 3-member set + indirect-prompt sweep; no further members
- R19, R21: delta — verified in-code (factories aligned; full build+test re-run personally)
- R1-R18, R20, R22-R33, R35-R41: unchanged

### Security expert
- R42: Checked — no issue (was Finding in Phase 2; fixed in 8e2eaa17; clause ①b does not fire post-fix)
- R19, R34, R39: Checked — no issue
- RS1-RS6: unchanged (RS1 N/A presence-check suppression; RS4/RS5 checked)
- R1-R18, R20-R33, R35-R38, R40, R41: unchanged

### Testing expert
- R7: verified — no OR-combined assertions (I5 honored)
- R19/RT1: verified — 4 factories extended; 5 untouched factories verified per-file safe
- R42: verified by independent re-derivation (self-check error from Phase 2 corrected)
- RT7: verified via deviation-log records
- R1-R6, R8-R18, R20-R41, RT2-RT6, RT8: unchanged

## Environment Verification Report

- VE1 (integration requires built dist): `verified-local` — `cd cli && npm run build` then `npx vitest run` (312/312; integration cases confirmed executed, not skipped). Also gated in CI job `cli-ci` (build→test order verified).
- VE2 (Homebrew-global repro not byte-reproducible locally): `verified-local` via behaviorally-identical `node cli/dist/index.js` spawns with isolated HOME/XDG (same entry point and credential resolution).
- No `blocked-deferred` paths.

## Resolution Status

### [F8] Minor — apiRequest rejections mislabeled "Parse error:" — Fixed
- Action: scoped `handleDecryptRequest` in its own catch emitting `Request failed: <message>`; `Parse error:` now covers only the JSON.parse/schema block. Added last-in-describe test with `mockRejectedValueOnce` asserting `Request failed: fetch failed` and NOT `Parse error`.
- Modified file: cli/src/commands/agent-decrypt.ts (handleConnection IIFE); cli/src/__tests__/integration/agent-decrypt-ipc.test.ts (new case).
- Red-proof: inner catch reverted → only the new test failed; restored byte-identical; 312/312 green.

### Round 2b test-hygiene gate — Fixed
- Action: converted direct `process.env.X =` mutations in the two touched test files to `vi.stubEnv` (unlock.test.ts PSSO_PASSPHRASE ×3; agent-decrypt.test.ts XDG_RUNTIME_DIR ×5) and added `unstubEnvs: true` to cli/vitest.config.ts (cli tree previously had no auto-unstub wiring). 312/312 tests + pre-pr 36/36. Round 3 testing review empirically verified hook-interplay safety (6/6 scenarios) and confirmed no test relied on env leakage.
- Modified files: cli/src/__tests__/unit/unlock.test.ts, cli/src/__tests__/unit/agent-decrypt.test.ts, cli/vitest.config.ts.

### Testing informational note (isTTY guarded restore) — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a stubbed `process.stdin.isTTY=true` own-property persists after the last test of agent.test.ts within its worker; no test observes it (last in only describe; cross-file leak empirically disproven under both parallelism modes).
  - Likelihood: zero observable impact today (empirical); could only matter if a future test is appended after the last-position test AND depends on isTTY.
  - Cost to fix: ~2 lines (`else { delete ... }`) but would touch the pre-existing pattern in agent-decrypt.test.ts too and trigger another review round for zero behavior change; the last-position comment already guards the same victim scope.
- **Orchestrator sign-off**: acceptable-risk exception satisfied.
