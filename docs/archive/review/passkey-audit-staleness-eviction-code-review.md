# Code Review: passkey-audit-staleness-eviction
Date: 2026-04-27
Review round: 1 (terminated — all in-scope findings fixed in the same branch)
Branch: fix/passkey-audit-staleness-eviction

## Changes from Previous Round
Initial code review.

## Summary

3 expert agents reviewed the F4 fix (staleness-based eviction for `passkeyAuditEmitted` Map). No Critical or Major findings. Three Low/Minor in-scope findings fixed before this commit; one Low pre-existing finding and one R3 propagation observation deferred to follow-up PRs.

## Functionality Findings

### Func F1 — Low: `lastEmitted &&` truthy check could bypass dedup at timestamp 0
- **File**: `src/proxy.ts:74` (now line ~78 after fix)
- **Problem**: Using `lastEmitted && ...` treats a literal-zero timestamp as falsy, bypassing the dedup branch and behaving as if the user had never been audited. `Date.now()` never returns 0 in production, but an alternate clock source (test fake, custom monotonic) could break the invariant silently.
- **Fix**: Replace with `lastEmitted !== undefined && ...`.
- **Status**: Resolved.

### Func F2 — Info: Dedup boundary 1ms semantics shift
- **File**: `src/proxy.ts:74` (the dedup condition)
- **Problem**: Original code used `> PASSKEY_AUDIT_DEDUP_MS` (would fire at exactly the boundary). Refactored code uses `<= PASSKEY_AUDIT_DEDUP_MS` (deduped at exactly the boundary). This is a deliberate inversion (matches "within 5 minutes" inclusively), but the JSDoc didn't call it out.
- **Fix**: Document the boundary semantics in the JSDoc with a reference to the test case.
- **Status**: Resolved.

### Func F3 (R3 propagation, [Adjacent — out of scope]) — Info: Other FIFO-eviction Maps in the codebase
- **Files**:
  - `src/lib/auth/policy/access-restriction.ts:51`
  - `src/lib/auth/session/session-timeout.ts:126`
- **Problem**: Same FIFO-vs-LRU eviction bug as the one this PR fixes — `Map.set()` on existing key doesn't reposition.
- **Anti-Deferral check**: out of scope (different feature). Not in this PR's diff. Each requires per-site analysis (some FIFO eviction is correct when entries are TTL-keyed and have a separate sweep).
- **Routing**: TODO(passkey-audit-staleness-eviction) — track in a follow-up PR. Note: `src/lib/proxy/auth-gate.ts:137` was assessed as functionally correct (TTL sweep precedes FIFO eviction).
- **Orchestrator sign-off**: Acceptable risk justified — these caches have different invalidation semantics (TTL-based or short-lived) and merit individual review. Filed as a separate concern.

## Security Findings

### Sec F1 — Low [Adjacent — pre-existing in unchanged file/path]: Empty userId fallback collision dedup
- **File**: `src/proxy.ts:159` (the `session.userId ?? ""` fallback at the call site)
- **Problem**: If `session.userId` is ever `undefined` after passing the upstream guards, `""` is used as the dedup key. Multiple unauthenticated/no-userId requests would share a single dedup slot.
- **Anti-Deferral check**: pre-existing pattern (predates this PR). The path is not reachable in practice because `session.userId` is set whenever `session.valid && session.requirePasskey`. The empty-string fallback is defensive type plumbing.
- **Routing**: Out of scope — a real fix requires verifying every code path that sets `session.userId` and the type narrowing. Track separately.
- **Orchestrator sign-off**: Pre-existing pattern, theoretical only — accepted with documentation. No code change in this PR.

### All other security checks: No findings
- R13 re-entrant dispatch loop: confirmed clean (audit-emit route does not loop through proxy passkey enforcement).
- DoS surface: unchanged (Map size bounded at 1000, ~80 KB).
- RS1-RS3: not applicable.
- Test shim exports: production code does not consume them; bundle exposure is not a security boundary.

## Testing Findings

### Test F1 — Minor: Missing `afterEach` in new describe block
- **File**: `src/__tests__/proxy.test.ts` (new `passkeyAuditEmitted staleness eviction` describe)
- **Problem**: The block has `beforeEach` (clears the Map) but no paired `afterEach`. Other describe blocks in this file consistently pair both hooks. Harmless today (last describe), but a future appended block would inherit a dirty Map without a cleanup pass.
- **Fix**: Add `afterEach(() => { _passkeyAuditEmitted.clear(); });` for symmetry.
- **Status**: Resolved.

### All other testing checks: No findings
- Test correctness (boundary math, refresh-saves-from-eviction logic, non-monotonic ordering): all assertions verified against the implementation.
- RT1 (mock-reality): N/A — tests exercise the SUT directly via exported helper.
- R19 mock alignment: N/A.
- R20 mechanical edit safety: appended block closes cleanly.
- Test count baseline: `capture-test-counts.mjs` removed in main; no baseline drift.

## Adjacent Findings

- **R3 propagation** (Func F3): two other FIFO-eviction Maps in `auth-gate.ts` (acceptable due to TTL sweep), `access-restriction.ts:51`, `session-timeout.ts:126` (same bug pattern). Out of scope for this PR.
- **Empty userId dedup** (Sec F1): pre-existing pattern, theoretical only.

## Quality Warnings
None.

## Recurring Issue Check

### Functionality expert
- R3 (propagation): Observation noted — three sibling Maps with the same pattern; one (auth-gate) is functionally OK due to TTL sweep, two are latent bugs deferred to follow-up PRs.
- R10 / R20 / R21: Pass.

### Security expert
- R3 / RS1-RS3: Pass.
- R13 re-entrant: Pass.
- R29: N/A — no spec citations.

### Testing expert
- R19 mock alignment: N/A.
- R20 mechanical edit: Pass.
- R21 build verification: Pass (run before commit).
- RT1: Pass — tests distinguish old/new behavior explicitly.
- RT2: Pass — test names accurately describe scenarios.
- RT3: Pass — coverage split (helper unit-tested, integration covered by existing proxy tests) is appropriate.

## Resolution Status

### Func F1 (Low) — `lastEmitted &&` → `lastEmitted !== undefined &&`
- Action: Changed the truthy check to an explicit `!== undefined` comparison.
- Modified file: `src/proxy.ts` (the dedup condition in `recordPasskeyAuditEmit`).
- Status: Resolved.

### Func F2 (Info) — Boundary semantics documentation
- Action: Added JSDoc paragraph explaining the `<=` boundary and its intentional 1ms shift, with a pointer to the test case.
- Modified file: `src/proxy.ts` (`recordPasskeyAuditEmit` JSDoc).
- Status: Resolved.

### Test F1 (Minor) — `afterEach` cleanup symmetry
- Action: Added `afterEach(() => { _passkeyAuditEmitted.clear(); });` to the new describe block.
- Modified file: `src/__tests__/proxy.test.ts`.
- Status: Resolved.

### Func F3 (Info, [Adjacent — out of scope])
- Action: Documented in this review log + PR description as TODO for follow-up.
- Anti-Deferral: out of scope (different feature, per-site analysis required). Filed as separate concern.
- Status: Deferred with documentation.

### Sec F1 (Low, [Adjacent — pre-existing])
- Action: Documented; no code change.
- Anti-Deferral: pre-existing pattern; the affected path is not reachable in practice given upstream session validation.
- Status: Deferred with documentation.

All in-scope findings resolved. PR ready.
