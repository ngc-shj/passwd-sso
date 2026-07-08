# Plan Review: vault-null-autolock-default

Date: 2026-07-08
Review rounds: 2

## Changes from Previous Round

Round 1: initial three-expert review of the plan closing `TODO(vault-null-autolock-default)`
(PR #642 follow-up). Round 2: verified the round-1 fixes, focused on the Critical S1
signature correction; one new Low finding (T6) surfaced and was applied.

## Functionality Findings

### Round 1
- **F1 (Minor) — resolved**: The RHS (`mergedSessionIdle`/`mergedExtIdle`) keeps
  `?? null` and skips the check for legacy null-idle rows; the plan asserted this
  in prose (SC1) but had no executable proof. Fix: added **EC6** (legacy DB
  `sessionIdleTimeoutMinutes = null`, request `vaultAutoLockMinutes = 10` → 200
  skip) as the SC1 proof.
- Round-1 Q6 gap (ext-token EC not enumerated) → folded into **EC2b** (see T3).

### Round 2
- No findings. Traced the corrected merge expression: every non-legacy case
  yields `number` (explicit-null→15, absent+DB-null→15, absent+DB-value→passthrough,
  explicit-value→passthrough). EC6 correctly skips (no false 400). EC3/EC5 no
  regression (the `?? DEFAULT` is a no-op for non-nullish ternary results).
  Non-blocking observation: `mergedVaultAutoLock` is now always numeric, so the
  two `typeof === "number"` LHS guards are vestigially always-true — harmless,
  the effective gate is the RHS operand's numeric check (intended).

## Security Findings

### Round 1
- **S1 (Critical, escalate:true) — resolved**: The original C3 signature placed
  `?? VAULT_AUTO_LOCK_DEFAULT` only on the DB-fallback branch of the ternary. An
  explicit `null` in the request body (`{vaultAutoLockMinutes: null,
  sessionIdleTimeoutMinutes: 5}`) takes the first branch (`null !== undefined`),
  yielding `mergedVaultAutoLock = null`; the downstream `typeof === "number"`
  guard then skips the cross-bound check — the fail-open persists for the
  explicit-null API path, contradicting the plan's own INV-C3b and EC1 (which
  expected 400). Fix: the `??` now wraps the **entire** ternary
  (`(vaultAutoLockMinutes !== undefined ? vaultAutoLockMinutes :
  currentTenant?.vaultAutoLockMinutes) ?? VAULT_AUTO_LOCK_DEFAULT`), and the
  Signature note documents the footgun. INV-C3b reworded.
  - **Escalation decision**: escalate:true was flagged. Orchestrator assessed the
    finding as unambiguous (ternary-branch trace, no trust-boundary complexity)
    and self-evidently correct — corroborated independently by the functionality
    and testing agents reading the same code. Accepted without Opus re-run; the
    round-2 security re-verification (below) confirms closure.

### Round 2
- No findings — S1 resolved. Re-traced: explicit-null → `null ?? 15` = 15 → 400.
  Store-vs-validate split confirmed consistent (stored null via
  `updateData.vaultAutoLockMinutes = vaultAutoLockMinutes ?? null`, validated
  against 15; every downstream reader applies the same 15-min default). RS3/RS4
  pass.

## Testing Findings

### Round 1
- **T1 (High) — resolved**: "the existing tenant-policy route test file" was
  ambiguous between two real files. Fix: plan now names
  `src/__tests__/api/tenant/tenant-policy.test.ts` (owns the existing cross-bound
  tests) and explicitly forbids adding to `src/app/api/tenant/policy/route.test.ts`.
- **T2 (High) — resolved**: red-before/green-after was prose, not a checkable
  gate. Fix: C3 acceptance now mandates adding+running EC2 pre-fix (observe 200),
  then fix, then 400, with PR-checkable enforcement (test-first commit or pasted
  pre-fix failure). Empirically reproduced: pre-fix `?? null` returns 200.
- **T3 (Medium) — resolved**: EC1/EC2 only covered `sessionIdle`; the identical
  `mergedExtIdle` guard had the same bug untested. Fix: added **EC2b**
  (extension-token variant → 400).
- **T4 (Low) — resolved, upgraded to required**: `auto-lock-context.test.tsx`
  re-derives `15 * MS_PER_MINUTE` locally, so a wrong extraction value could pass
  vacuously. Fix: C2 acceptance now REQUIRES a direct-import assertion
  (`import { VAULT_AUTO_LOCK_DEFAULT }; expect(...).toBe(15)`).
- **T5 (Low) — resolved**: fixture completeness. Fix: Testing strategy requires a
  complete `currentTenant` (all three relevant fields) in every EC test.

### Round 2
- **T6 (Low, new in round 2) — resolved**: The red-green gate (T2) anchored only
  on EC2, but EC2 hits the DB-fallback branch and would pass even under the
  DB-branch-only `??` misplacement S1 warned about. EC1 (explicit-null, request
  branch) is the case that specifically catches that footgun. Fix: the gate now
  ALSO requires observing EC1 red-before/green-after as the mechanized proof of
  INV-C3b's whole-ternary placement.

## Adjacent Findings

None routed cross-scope; all findings stayed within originating scope.

## Quality Warnings

None. All findings carried file:line evidence; T2's regression claim was
empirically reproduced (200 pre-fix) rather than asserted.

## Recurring Issue Check

### Functionality expert
- Constant/enum consumers: pass (all VAULT_AUTO_LOCK consumers enumerated).
- Shared-utility discovery: pass (no existing default-resolution helper; inline
  `?? DEFAULT` matches file convention).
- Type-shape (merge now non-nullable): pass (all branches → number; guards safe).
- Consumer-flow (client card round-trip): pass (INV-C3c; updateData reads raw field).
- Do-not-blindly-follow-pattern (vault vs jit/deleg `?? null`): pass (justified by
  client-side default asymmetry; EC6 provides executable proof).
- Edge-case completeness: pass (EC1/EC2/EC2b/EC3/EC4/EC5/EC6 enumerated).

### Security expert
- RS1 (authz bypass): pass (MEMBER_MANAGE + step-up gates untouched).
- RS2 (injection): n/a (pure integer comparison).
- RS3 (fail-open direction): pass (closes fail-open on both explicit-null and
  absent paths; fail-closed is safer direction; no new fail-open).
- RS4 (business-logic bypass via alternate path, A04): pass (the explicit-null
  alternate branch that S1 exploited is folded into the same default).
- RS5 (secrets/PII in logs): pass (vaultAutoLockMinutes logged as plain integer).

### Testing expert
- R-common-testing (regression red-before/green-after): resolved (T2 + T6 gates).
- R-common-testing (no decorative tests): resolved (T4 direct-import assertion).
- RT1 (framework detection): ok (vitest/Playwright).
- RT2 (mock at module scope, typed): ok.
- RT3 (React components via rendered DOM): ok.
- RT7 (fixture realism, no vacuous `{}`): resolved (T5).
- feedback_triangulate_enumerate_completeness: applied (T3 ext-idle, T6 EC1/EC2
  branch enumeration derived from re-reading the guard class, not the prompt list).
