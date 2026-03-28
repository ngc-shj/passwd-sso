# Code Review: separate-db-roles
Date: 2026-03-28
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Critical] RESOLVED: load-test seed uses passwd_app but needs SUPERUSER for RLS bypass
- Action: Reverted load-test/README.md to use `passwd_user` (SUPERUSER) for seed/cleanup
- Modified file: load-test/README.md

### F2 [Major] RESOLVED: CI smoke test only checks 1 table
- Action: Added `service_accounts` table to smoke test assertions
- Modified file: .github/workflows/ci.yml

## Security Findings

### S1-S3 [Minor] ACKNOWLEDGED: Default password, machine identity tables, bypass_rls scope
- All Minor findings from existing patterns, not regressions

## Testing Findings

### T4 [Critical] RESOLVED: Vacuous assertion on empty table
- Action: Added seed data INSERT (teams + service_accounts) as SUPERUSER before verification
- Modified file: .github/workflows/ci.yml

### T3 [Major] RESOLVED: Machine identity tables not verified (merged with F2)
- Action: Added `service_accounts` assertion in smoke test

### T5 [Minor] RESOLVED: Empty string test for MIGRATION_DATABASE_URL
- Action: Added `rejects empty MIGRATION_DATABASE_URL` test case
- Modified file: src/lib/env.test.ts

### T1-T2, T6 [Minor] ACKNOWLEDGED: Pre-existing test naming/consistency issues, not in scope

## Resolution Status
All Critical and Major findings resolved. Minor findings acknowledged.
