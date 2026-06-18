# Code Review: retention-mcp-token-family (SC5)
Date: 2026-06-18
Review rounds: 1 (plan review + code review, both converged)

## Plan review (1 round)
3-perspective review found 3 issues, all fixed before implementation:
- **S1 (Major)**: C4 prose wrongly claimed Postgres requires the invoking role to hold DELETE on cascade-target tables. Corrected: RI cascade runs as an internal trigger without re-checking invoking-role privilege; children need SELECT-only (for the guard subquery). RLS on cascade targets satisfied via bypass_rls. **Empirically confirmed** by the role-grant integration test (worker role cascade-deletes with children SELECT-only).
- **F1 (Minor)**: sweepOnce dispatch must use explicit per-kind branches, not elimination-else. Fixed.
- **T1 (Minor)**: guard negative tests must assert the live child row survives (not just parent count). Fixed.

## Code review (1 round)
3-perspective review found 1 real issue:
- **T1 (test-only type error)**: widening the registry.test.ts DMMF loop to include `EXPIRY_GUARDED` (which has no `predicate` field) introduced a `tsc` error at the predicate-column assertion. Missed by `next build` (excludes test files from typecheck) and `vitest` (esbuild strips types). **Fixed**: re-narrowed the predicate block to `entry.kind === "EXPIRY"`. Verified `tsc --noEmit` clean for retention-gc files.
  - Note: `src/auth.config.test.ts:289` has a pre-existing `tsc` error on main, unrelated to SC5 — left for a separate fix (outside SC5 scope, not introduced here).

All other focus areas verified clean: S1 SQL-injection containment (guard SQL is code-literal, only `${parent}` interpolated after assertIdentifier, only `$1` bound); guard correctness (per-access-token NOT EXISTS matches cascade granularity; revoked/expired children don't pin parent); boot validator handles EXPIRY_GUARDED; R14 least-privilege (children SELECT-only, no over-grant, cascade proven); RT7 negative tests assert live-child survival.

## Verification
- Unit: 62 worker tests (incl. guarded-SQL shape pin). `tsc --noEmit` clean (retention-gc).
- Integration (real DB): 6 tests — family-dead cascade delete, live-refresh-token guard holds, live-delegation guard holds, revoked-token-doesn't-pin, worker-role cascade with children SELECT-only (R14 proof), worker-role-cannot-direct-DELETE-children (negative grant).
- Full suite: 11384 unit tests pass; lint clean; `next build` green.
- Migration applied to dev DB; grants verified via information_schema (parent SELECT+DELETE, children SELECT-only).

## Verdict
Converged. Core design (EXPIRY_GUARDED kind, code-enum guard, per-access-token NOT EXISTS, S1 containment, least-privilege cascade) correct. The R14 cascade-privilege correction is the headline — empirically confirmed children need SELECT-only.
