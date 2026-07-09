# Plan Review: cli-unhandled-rejection
Date: 2026-07-09
Review rounds: 4 (converged — all experts "No findings")

## Round Summary

| Round | Functionality | Security | Testing | Plan edits |
|-------|--------------|----------|---------|-----------|
| 1 (full) | F1,F2,F4,F5 Minor; F3 Major; F6-A,F7-A adjacent | No findings; S-A1 adjacent | T1,T2 Major; T3,T4,T5 Minor | F1/F3/F4/F5, T1-T5, Scenario 4 applied; F2 accepted |
| 2 (incremental) | No findings (all fixes verified, incl. live commander probe) | No findings (I3b verified security-positive) | T6 Major (new): sticky mockImplementation leaks past clearAllMocks (vitest 4.1.8, empirically reproduced) | T6 → mockImplementationOnce mandated; RT7 expected-red-shapes recorded |
| 3 (testing only) | — | — | T6 resolved; T7 Minor (new): unconsumed once-impl survives clearAllMocks (noise-only, no false green) | T7 → ordering case declared last in describe |
| 4 (testing only) | — | — | No findings (T7 fix verified; last-in-describe = last-in-file; per-file module isolation) | — |

Cumulative: Critical 0 / Major 3 (F3, T1, T2→all resolved; +T6 resolved) / Minor 8 (7 resolved in plan, F2 accepted with quantification).

## Round 1 Detail
Initial review.

## Functionality Findings

[F1] [Minor]: Plan's C1 snippet uses `process.argv` explicitly where existing code relies on the default
- File: plan C1 signature block vs cli/src/index.ts:197
- Evidence: `program.parse();` (no args) today; commander's `parseAsync()` with zero args behaves identically.
- Fix: use `await program.parseAsync();` for minimal diff; don't add `{ from: ... }`.

[F2] [Minor]: `String(err)` on a thrown non-Error object may print `[object Object]`
- Evidence: all first-party throw sites use `new Error(...)` (verified by grep); degenerate output only via third-party plain-object throws.
- Fix: acceptable as planned (no stack trace, exit 1 still hold).

[F3] [Major]: I3 "exactly one place" invariant vs env.ts/run.ts null-check idiom — plan must forbid migrating them
- File: cli/src/commands/env.ts:47-53, cli/src/commands/run.ts:50-56 vs plan C2
- Evidence: env/run use `getToken()` null-check + own message (", or set apiKey in config") + process.exit(1).
- Fix: add C2 invariant: env/run keep their idiom (must not throw; different message); migrating them to assertLoggedIn() is forbidden in this PR.

[F4] [Minor]: State that the try/catch replaces line 197 in place; `interactiveMode` declaration below hoists and needs no move.

[F5] [Minor]: FR1 scope note points at SC2, which is about message wording; commander-internal usage-error exits (exit 1 inside commander) should be named explicitly in SC2.

Second verification pass (same expert, final message) — additional verified evidence:
- commander 13.1.0 parseAsync source (command.js:1101): async-rejection AND sync-throw paths propagate to awaited parseAsync (runtime repro confirmed).
- Baseline: `npx vitest run --root cli` → 304/304 pass pre-fix (clean RT7 baseline).
- Scenario 4 wording imprecision: OAuth-path saveCredentials is inside oauthLogin's local try/catch (never reaches C1); only the `--token` manual-paste path's saveCredentials propagates to C1.
- Ctrl+C in readPassphrase exits 130 directly, bypassing C1 — pre-existing, correctly out of contract surface.

## Security Findings

No findings.

Rationale highlights: C1 output is a strict reduction vs today's uncaught-exception dump (message already printed as line 1 + stack); passphrase never present in any thrown Error.message on traced paths (unlock.ts catches decrypt/derive failures internally with a fixed string); C2 reorder removes an interactive read (no new echo/capture window); no local auth-oracle (single-user local process); process.exit(1) introduces no partially-written secret file or clipboard leftover; config.ts:86 symlink message safe to print.

## Testing Findings

[T1] [Major]: Existing unlockCommand test suite breaks once assertLoggedIn is wired in — unlock.test.ts:4-6 mock factory exports only apiRequest
- Evidence: pre-existing tests (lines 310, 343) will throw `TypeError: assertLoggedIn is not a function`.
- Fix: add `assertLoggedIn: vi.fn()` to the factory with a no-op default for pre-existing cases; list as a concrete required edit in C3.

[T2] [Major]: Spawned unlock integration test can hang if C2 regresses — stdin-closing strategy unspecified
- Evidence: reproduced — open-pipe stdin hangs at prompt (HANG CONFIRMED, 3000ms); /dev/null stdin → immediate "Passphrase is required.".
- Fix: specify `execFileSync(..., { input: "" })` or `stdio: ["ignore","pipe","pipe"]` so a C2 revert fails fast on wrong-assertion instead of hanging.

[T3] [Minor]: "No prompt written" assertion mechanism unspecified; readPassphrase is same-module-called (ESM binding bypasses namespace spies)
- Fix: specify `vi.spyOn(process.stdout, "write")` and assert never called with "Master passphrase:" (matches the file's existing spy approach at unlock.test.ts:315-341).

[T4] [Minor]: New ordering test must override assertLoggedIn mock to THROW; the blanket no-op from T1's fix would make it a vacuous pass.

[T5] [Minor]: Member-set framing — env/run are covered members but were never stack-trace-prone (own process.exit(1) fail-fast); add a one-line clarity note next to the derivation.

Additional verified: chalk 5 disables color on non-TTY piped output (substring assertions safe); api-key list correctly proves C1 independently of C2 (api-key.ts:25-30, no local guard; red-on-revert reproduced).

## Adjacent Findings

- [F6-A] Major → Testing: readPassphrase Ctrl+C path exits 130 in raw-mode handler; C3 spawns unlock only WITHOUT credentials (stdin listener never reached with C2 in place). Resolved by T2's closed-stdin spec (hang-avoidance covered).
- [F7-A] Minor → Security: oauth.ts:215/280 messages embed server response bodies; Security expert confirmed strict-reduction reasoning (no finding).
- [S-A1] → Functionality: SC1 exit-0-despite-error-output paths (apiKeyListCommand HTTP-error, unlockCommand empty-passphrase). Pre-existing, explicitly scoped out as SC1 with TODO(cli-exit-codes).

## Quality Warnings

None flagged by merge-findings quality gate (all findings carry file/line evidence and concrete fixes).

## Resolution Status (Round 1)

- F1 → Fixed in plan (C1 snippet now `await program.parseAsync();`).
- F3 → Fixed in plan (C2 invariant I3b + forbidden pattern: env/run migration prohibited).
- F4 → Fixed in plan (C1 in-place replacement + hoisting note).
- F5 → Fixed in plan (SC2 extended to name commander-internal exits).
- Scenario-4 wording → Fixed in plan (now exercises the `--token` manual-paste path).
- T1 → Fixed in plan (C3 lists the unlock.test.ts factory edit as a required concrete edit).
- T2 → Fixed in plan (C3 specifies closed-stdin spawn config).
- T3 → Fixed in plan (C3 names the stdout-write spy mechanism).
- T4 → Fixed in plan (C3 requires per-test throwing mockImplementation).
- T5 → Fixed in plan (member-set note added).

### [F2] [Minor] `String(err)` fallback may print `[object Object]` — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a third-party dependency throws a plain object → user sees `✗ [object Object]` with exit 1 and no stack trace; core contract (no stack trace, non-zero exit) still holds.
  - Likelihood: low — all first-party throw sites use `new Error(...)` (expert-verified grep); commander/chalk/cli-table3 do not throw plain objects in normal operation.
  - Cost to fix: ~3 LOC (JSON.stringify fallback), but adds an untestable branch and diverges from the REPL's existing fallback idiom; YAGNI.
- **Orchestrator sign-off**: acceptable-risk exception satisfied with the three values above.

### [S-A1] Pre-existing exit-0 error paths — Out of scope
- **Anti-Deferral check**: out of scope (different feature).
- **Justification**: tracked by the plan's Scope contract SC1 with grep-able marker `TODO(cli-exit-codes)`; behavior-contract change beyond the reported bug, needs its own user decision.
- **Orchestrator sign-off**: SC1 citation satisfies the out-of-scope exception.

## Recurring Issue Check

### Functionality expert
- R1: checked — output.error reused; assertLoggedIn centralizes existing inline throw; no existing exit/error helper beyond output.ts
- R2: checked — message single-sourced in assertLoggedIn (I3); env/run variants distinct by design (F3)
- R3: checked — single parse site verified (index.ts:197 only)
- R4: not applicable — no events/mutations
- R5: not applicable — no DB
- R6: not applicable
- R7: not applicable — no UI selectors; C3 negative assertions per I5
- R8: not applicable
- R9: not applicable — no DB transactions; bg refresh timer unref'd
- R10: checked — no new import edge cycle (unlock.ts already imports api-client.js)
- R11: not applicable
- R12: not applicable
- R13: not applicable
- R14: not applicable
- R15: not applicable
- R16: checked — AC3-2 tsc in CI; TLA compiles under NodeNext; skipIf(!dist) both envs
- R17: checked — primitive call sites: apiRequest (adopts), unlockCommand (adopts), env.ts:47/run.ts:50 (skip with concrete reason; see F3)
- R18: not applicable
- R19: checked — plan enumerates all 9 files mocking lib/api-client; matches independent grep
- R20: not applicable at plan stage
- R21: not applicable at plan stage — Phase 2 full vitest run + build required
- R22: checked — inverted check: no other "not logged in" fail-fast beyond env/run (3 production hits, all accounted)
- R23: not applicable
- R24: not applicable
- R25: not applicable
- R26: not applicable
- R27: not applicable
- R28: not applicable
- R29: checked — no external specs cited; commander 13 parseAsync verified against installed typings and source (command.js:1101)
- R30: checked — plan file has no bare #N/@name/SHA
- R31: not applicable
- R32: not applicable — CLI short-lived
- R33: checked — no CI config changes; cli build/test wired via pre-pr.sh
- R34: checked — class fixed class-wide by C1 choke point; env/run different class (handled)
- R35: not applicable — CLI package, not deployed service
- R36: not applicable
- R37: checked — message contains no internal jargon
- R38: checked — catch is terminal failure path; no transient state; no fail-open supersession surface
- R39: not applicable — fail-fast happens BEFORE passphrase read (improvement)
- R40: not applicable — exit-code contract covered by C1 consumer walkthrough
- R41: not applicable
- R42: checked — independently recomputed 12 members at lines 64,70,75,91,105,112,122,131,143,150,158,170; single parse site; REPL indirect member accounted; no delta

### Security expert
- R1: checked — assertLoggedIn is genuine dedup, not reimplementation
- R2: N/A
- R3: checked — single choke-point pattern, no propagation needed
- R4: N/A
- R5: N/A
- R6: N/A
- R7: N/A (testing scope; plan I5 covers non-OR assertion)
- R8: N/A
- R9: N/A
- R10: checked — no new import edge
- R11: N/A
- R12: N/A
- R13: N/A
- R14: N/A
- R15: N/A
- R16: N/A
- R17: checked — apiRequest + unlockCommand covered; env.ts:49/run.ts:52 excluded with reason (I3)
- R18: N/A
- R19: N/A for security scope (plan enumerates 9 mock files)
- R20: N/A
- R21: N/A (plan phase)
- R22: checked — no divergent expectation between producer/consumers of assertLoggedIn
- R23: N/A
- R24: N/A
- R25: N/A
- R26: N/A
- R27: N/A
- R28: N/A
- R29: N/A — no spec citations in plan or this review
- R30: N/A — no bare autolinks in plan doc
- R31: N/A — RT7 red-proof is local, reversible, test-only
- R32: N/A
- R33: N/A
- R34: checked — SC1 exit-0 paths flagged as [Adjacent] to Functionality
- R35: N/A
- R36: N/A
- R37: checked — no internal jargon in rendered messages
- R38: checked — single try/catch, deterministic exit; no fire-and-forget left unresolved
- R39: checked — no secret-holder lifecycle transition touched; clearTokenCache/lockVault unchanged
- R40: N/A
- R41: N/A
- R42: checked — independently re-ran greps; 12 .action sites, single program.parse site; no delta vs plan
- RS1: N/A — no credential comparison touched
- RS2: N/A — no new API route
- RS3: N/A — assertLoggedIn takes no input
- RS4: checked — plan file has no personal-identifying data
- RS5: checked — server-response text in error messages is display-only, never fed to crypto/authz primitive
- RS6: N/A — no chained .replace() sanitizer

### Testing expert
- R1: N/A — assertLoggedIn is DRY dedup, no duplication
- R2: N/A — message consolidated into one helper (I3)
- R3: N/A — no external standards cited
- R4: N/A — no constant/enum changes
- R5: Pass — I3 grep verified accurate (3 pre-fix hits, env/run legitimately different)
- R6: N/A — no vague test recommendations; T3 flags underspecified mechanism
- R7: Verified — I5 forbids OR-fallback; zero existing `toContain.*||` hits
- R8-R18: N/A (except R16 covered via pre-pr wiring, see RT8)
- R19: Verified with finding T1 — 8 other factories safely partial; unlock.test.ts's OWN factory must add assertLoggedIn
- R20-R41: N/A
- R42: Verified — recomputed 12-member set identical; api-key list correctly chosen (no local guard) to prove C1 independent of C2
- RT1: Finding T1 — mock factory divergence once assertLoggedIn is added
- RT2: Applied — verified same-module call binding; recommendation testable via stdout spy (T3)
- RT3: N/A — vitest.config.ts covers new test files
- RT4: N/A
- RT5: N/A
- RT6: N/A
- RT7: Verified with findings — api-key list red-proof genuine; unlock red-proof risks hang (T2)
- RT8: N/A — pre-pr.sh:530-538 already wires cli build→test in correct order
