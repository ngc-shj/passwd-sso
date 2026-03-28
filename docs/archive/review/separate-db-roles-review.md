# Plan Review: separate-db-roles
Date: 2026-03-28
Review round: 2

## Changes from Previous Round

### Round 1 → Round 2 (all resolved)
- F1 Critical: Fixed — `process.env` check instead of `??`
- F2 Critical: Fixed — `\if :{?var}` + `:'var'` psql expansion
- F3 Major: Fixed — `.env.example` (correct filename)
- F4 Major: Fixed — all setup docs added to Files to Update
- S1 Major: Documented — "Known Limitation" section added
- S2 Major: Fixed — dummy `build.args` URL
- T1 Critical: Fixed — Step 10 required, CI job in Files to Update
- T3 Major: Fixed — Step 7 for env.ts Zod schema

### Round 2 new findings (all resolved)
- F-NEW-1 Major: Fixed — `CASE WHEN ... THEN 'true' ELSE 'false'` for `\gset`
- F-NEW-4/T-N3 Major: Fixed — CI uses `psql` setup step instead of initdb volume mount
- T-N1 Major: Fixed — CI step explicitly connects as `psql postgresql://passwd_app:...`
- F-NEW-5 Minor: Fixed — Scenario 1 updated to `.env.example`
- T-N2 Minor: Fixed — Zod validator uses `refine()` + `new URL()` pattern

## Functionality Findings

### F1 [Critical] RESOLVED: `env()` throws — used `process.env` conditional
### F2 [Critical] RESOLVED: `\getenv` namespace — psql `\if`/`:'var'` expansion
### F3 [Major] RESOLVED: `.env.example` in Files to Update
### F4 [Major] RESOLVED: Setup docs added
### F-NEW-1 [Major] RESOLVED: `\gset` boolean — `CASE WHEN` returns `'true'`/`'false'`
### F-NEW-4 [Major] RESOLVED: CI psql setup step (no volume mount needed)

## Security Findings

### S1 [Major] RESOLVED: `bypass_rls` GUC documented as known limitation
### S2 [Major] RESOLVED: Dummy build.args URL

## Testing Findings

### T1 [Critical] RESOLVED: CI smoke test required, explicit `passwd_app` connection
### T2 [Major] ACKNOWLEDGED: `tenant-rls.test.ts` mock-only (pre-existing, not in scope)
### T3 [Major] RESOLVED: env.ts Zod schema with `refine()` pattern

## Adjacent Findings
(None)

## Resolution Status
All Critical and Major findings resolved. Plan ready for finalization.
