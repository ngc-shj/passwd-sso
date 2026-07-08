# Code Review: vault-null-autolock-default

Date: 2026-07-08
Review round: 1 (Phase 3)

## Changes from Previous Round

Initial Phase 3 code review of the implemented diff (5 source/test files) on
branch `fix/vault-null-autolock-default`. Phase 1 plan review already ran 2
rounds and fixed a Critical (S1: explicit-null bypass) at the plan stage; Phase 2
verified red-before/green-after empirically. This round verified the ACTUAL
committed code against the plan contracts.

## Functionality Findings

No findings. All six verification points confirmed against `git diff main...HEAD`:
- C3 parenthesization correct — `(ternary) ?? VAULT_AUTO_LOCK_DEFAULT` wraps the
  whole ternary; explicit-null and absent both resolve to 15.
- `tsc --noEmit` clean, ESLint clean on the three changed source files. The two
  `typeof mergedVaultAutoLock === "number"` guards are now tautological but fire
  no lint (harmless).
- INV-C3c holds: `mergedVaultAutoLock` appears only at its definition and the two
  comparisons; `updateData.vaultAutoLockMinutes = vaultAutoLockMinutes ?? null`
  recomputes from the raw request param, so the default never leaks into storage
  or the response body.
- Imports correct (both `route.ts` and `auto-lock-context.tsx` import from
  `@/lib/validations/common`).
- No regression on explicit-value paths (EC3/EC6 pass).
- Value 15 matches the pre-change client literal. Extension (`DEFAULTS.autoLockMinutes
  = 15`) and iOS (`_autoLockMinutes = 15`, `defaultMinutes = 15`) keep their own
  local constants in separate codebases with no shared-constant mechanism —
  correctly out of scope, value-consistent, not a silent divergence.

## Security Findings

No findings. S1 confirmed closed in the actual code:
- Traced `{vaultAutoLockMinutes: null, sessionIdleTimeoutMinutes: 5}` → inner
  ternary `null` → `null ?? 15` → 15 → `15 > 5` → 400. Confirmed by passing EC1.
- No residual bypass: `vaultAutoLockMinutes` is validated (integer in [5,1440] or
  null/undefined) and returns early BEFORE the merge, so no string/NaN/0/negative
  reaches the merge unvalidated.
- Authz + step-up unchanged (no diff in that region).
- Storing null while validating 15 introduces no downstream fail-open — every
  reader applies the same 15-min default; the diff consolidates the previously
  duplicated client/server 15 into one named constant (removes drift risk).
- No new secrets/PII logged; audit metadata shape unchanged.
- RS1-RS5 all pass.

## Testing Findings

- **T1 (Low) — resolved**: coverage gap — the (explicit-null | absent) × (sessionIdle
  | extIdle) matrix had 3 of 4 cells covered; "explicit-null vaultAutoLock ×
  extension-token-idle violation" was untested. Fix: added **EC2c** (explicit
  `vaultAutoLockMinutes: null` + `extensionTokenIdleTimeoutMinutes: 5` → 400).
  Non-blocking completeness nit; fixed in-round per the 30-minute rule.
- Vacuity independently verified: the reviewer reverted the route ternary and
  re-ran — EC1/EC2/EC2b failed (200≠400), EC3/EC6 stayed green (non-vacuous
  negative control), then restored. The client value-regression assertion was
  verified by temporarily setting the constant to 20 (assertion failed as
  expected), then restored.
- Fixture completeness confirmed: all EC fixtures set all three idle/vault fields
  explicitly (number or null, never undefined), matching the Prisma select shape.
- `mockUpdateReturn` realism confirmed: `FULL_POLICY_RESPONSE` is a complete
  object; EC3/EC6 overrides produce a full shape, no vacuous pass.

Note on reviewer method: two reviewers (functionality, testing) temporarily
mutated `VAULT_AUTO_LOCK_DEFAULT` (15→20) in their own sandboxed check to prove
the assertions catch drift, then restored via `git checkout`. Working tree
verified clean at committed `15` afterward; no residue (R21 spot-check passed —
the mutations were on the reviewers' side, not left in the production source).

## Adjacent Findings

None routed cross-scope.

## Quality Warnings

None. Every finding carried file:line evidence; vacuity and value-regression
claims were empirically reproduced (revert-and-rerun), not asserted.

## Recurring Issue Check

### Functionality expert
- R2 (shared constant / no magic-number drift): satisfied — 15 consolidated into
  VAULT_AUTO_LOCK_DEFAULT; `* MS_PER_MINUTE` derives from base constant.
- R21 (no mutation residue in production source): pass — reviewer mutations
  restored, tree clean.
- Const-object / time-constants / suppression rules: N/A or satisfied.

### Security expert
- RS1 (fail-open on null/undefined): pass — closed, trace + regression tests.
- RS2 (bypass via coercion): pass — validation precedes merge.
- RS3 (authz/step-up regression): pass — no diff in that region.
- RS4 (client/server default drift): pass — actively fixes a prior instance.
- RS5 (secrets/PII in logs): pass — none introduced.

### Testing expert
- RT (non-vacuous / red-before-green): pass — verified by revert-and-rerun.
- feedback_multi_agent_review_gaps (fixture/mock-return realism): pass.

## Environment Verification Report

N/A — no environment constraints declared in Phase 1 (all paths `verifiable-local`;
route unit tests and client unit test executed locally and pass).

## Resolution Status

### T1 (Low) Coverage gap: explicit-null vaultAutoLock × ext-idle untested
- Action: added EC2c test case (explicit null + extensionTokenIdle=5 → 400).
- Modified file: `src/__tests__/api/tenant/tenant-policy.test.ts` (EC2c block).
- Verification: `npx vitest run src/__tests__/api/tenant/tenant-policy.test.ts`
  → 36 passed. pre-pr.sh → 44/44 pass.

All Critical/Major/Minor findings resolved. One Low finding fixed in-round.
