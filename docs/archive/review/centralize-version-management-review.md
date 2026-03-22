# Plan Review: centralize-version-management
Date: 2026-03-22
Review round: 2

## Changes from Previous Round
- F1 resolved: Bump script validation restricted to strict `X.Y.Z` only
- F2 resolved: `manifest.config.ts` added to extension tsconfig `include`
- S1 resolved: Bump script uses `process.argv` instead of shell interpolation
- S2 resolved: CI step uses `working-directory: ${{ github.workspace }}`
- T1 resolved: CLI version unit test added (Step 1b)
- T2 resolved: Extension manifest CI verification step added (Step 4b)

## Round 1 Findings (all resolved)

### F1 [Major] Semver prerelease vs Chrome manifest contradiction — RESOLVED
### F2 [Minor] manifest.config.ts not in tsconfig include — RESOLVED
### S1 [Minor] Shell variable interpolation in bump script — RESOLVED (Opus downgraded from Critical)
### S2 [Minor] CI working-directory not explicit — RESOLVED
### T1 [Major] No automated test for CLI version — RESOLVED
### T2 [Major] No automated test for extension manifest version — RESOLVED
### T3 [Major] CI version-check path filter concern — INVALID (plan already addressed)

## Round 2 New Findings

### N1/T6 [Major] CLI `program.parse()` blocks unit testing
- **Problem:** `cli/src/index.ts` calls `program.parse()` at module top-level (line 132). Importing the module in a test would execute parse with vitest's `process.argv`, causing a crash.
- **Impact:** CLI version unit test (Step 1b) cannot use module import approach.
- **Resolution:** Plan updated — test uses child process execution (`node dist/index.js --version`) instead of module import. No refactoring of existing code needed.

### T7 [Major] Extension manifest CI step comparison command unspecified
- **Problem:** Plan didn't specify how to compare manifest version with root in CI (extension-ci uses `working-directory: extension`).
- **Resolution:** Plan updated — explicit `node -p` commands with `../package.json` path for root version.

### N2 [Minor] Bump script regex pattern not explicit in plan
- **Problem:** Plan said "strict X.Y.Z" but didn't specify the regex, allowing potential issues like leading zeros.
- **Resolution:** Plan updated — regex specified as `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`.

### T8 [Major] version-check job scope documentation — SKIPPED
- **Reason:** Documentation concern only. The job correctly validates version field consistency. Runtime propagation is covered by separate tests (Step 1b, Step 4b).

### N3 [Minor] Lock file self-version update — SKIPPED
- **Reason:** `npm install --package-lock-only` does update `packages[""].version` in `package-lock.json`.

### N4/T9 [Minor] Path fragility / manual dynamic check — SKIPPED
- **Reason:** Already documented in Considerations. CLI version test (Step 1b) provides CI coverage.

## Adjacent Findings

### [Adjacent from Security, Round 1] JSON.stringify reformatting — ACCEPTED
- Minor formatting differences from `JSON.stringify(pkg, null, 2)` are acceptable. npm/node tooling produces consistent 2-space indent output matching project style.
