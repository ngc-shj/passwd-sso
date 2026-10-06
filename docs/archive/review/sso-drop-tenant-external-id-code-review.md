# Code Review: sso-drop-tenant-external-id
Date: 2026-10-06
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening found stale "external id" wording in the CLI help, flag description and `--from` message; fixed before the expert round (ee6fc7000, deviation D-7).

## Functionality Findings
No findings. Implementation Checklist cross-checked against the diff — every listed file present.

## Security Findings
- **S1 [Major, R3/R29]** — `src/auth.ts` (no diff lines, consumer of `ClaimLookup`) kept three comments describing the removed owner-carrying fold-collision arm. Not behavioural: the switches are exhaustive over the narrowed unions.

## Testing Findings
- **T1 [Major]** — plan C4's acceptance (`tenant-domain preflight` is an unknown command) had no test; the integration suite never reaches `main()`'s dispatch.
- Seed "dead `tenant.create` mock in resolve-tenant-by-claim.test.ts" — rejected by the expert: the whole `tenant` mock key is already gone.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1, R2, R3, R5, R12, R18, R19, R29, R34, R37, R42 Clean; all other R1–R57 N/A.
### Security expert
R1 N/A, R2 Pass, R3 Fail, R4 N/A, R5 Pass, R6–R11 N/A, R12 Pass, R13 N/A, R14 Pass, R15–R17 N/A, R18 Pass, R19 Pass, R20–R23 N/A, R24 Pass, R25–R28 N/A, R29 Fail, R30 N/A, R31 Pass, R32 N/A, R33 N/A, R34 Fail, R35 N/A, R36 N/A, R37 Pass, R38–R41 N/A, R42 Pass, R43–R47 N/A, R48 Pass, R49 Pass, R50–R57 N/A, RS1 N/A, RS2 N/A, RS3 Pass, RS4 Pass, RS5 N/A, RS6 N/A (R3/R29/R34 all = S1)
### Testing expert
R3 Finding (T1), R19 Pass, R29 Pass, R42 Pass; other R1–R57 N/A. RT1 Pass, RT2 Pass, RT3 Pass, RT4 Pass, RT5 Pass (retracted: real-DB coverage of `resolveTenantByClaim` remains via `audit-sentinel-claim-denial.integration.test.ts`), RT6 Pass, RT7 Pass, RT8 Pass, RT9 N/A, RT10 Pass, RT11 Pass.

## Environment Verification Report
- VE1 (deploy window, old code against the new schema) — `blocked-deferred`; Phase 1 constraint VE1 with its Anti-Deferral entry in the plan. No production roll exists.
- VE2 (integration tests need local Postgres with workers stopped) — `verified-local`: `docker compose stop audit-outbox-worker retention-gc-worker && npm run test:integration` → 117 files / 730 tests passed.
- C1 migration — `verified-local`: applied to the dev DB; `prisma migrate status` up to date; `check:migration-drift` consistent.

## Resolution Status
### S1 [Major] Stale fold-collision prose in src/auth.ts
- Action: rewrote the three comments to the current arms (revoked carries the owner; unstorable has none). Swept every consumer of `ClaimLookup` / `ClaimTenantResolution` / `ClaimRefusalKind` / `resolveTenantRef` / bucket maps for collision / fold / external id / preflight / release-1 prose; remaining hits are unrelated or historical notes on why a test was deleted.
- Modified file: src/auth.ts (lookupOwnerId JSDoc, claimedTenantMembership comments) — 982746ecd

### T1 [Major] Removed subcommand dispatch untested
- Action: added `scripts/__tests__/tenant-domain-cli-dispatch.test.ts`, which runs the CLI as a process: `preflight` → usage, exit 1, no handler reached; `list` on the same path → reaches its handler (`MIGRATION_DATABASE_URL is required`). No DB needed. Red-proven on a scratch copy by restoring a `case "preflight"` arm — the first case fails.
- Modified file: scripts/__tests__/tenant-domain-cli-dispatch.test.ts — 3280ecbdc
