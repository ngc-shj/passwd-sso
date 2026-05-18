# Plan Review: harden-rls-delegation-boundaries

Date: 2026-05-19
Review rounds: 2 (plan frozen with locked Go/No-Go gate)

## Changes from Previous Round

**Round 1 → Round 2**: Plan expanded from 5 contracts (C1-C5, RLS/delegation only) to 10 contracts (C1-C10, adding iOS DPoP / mobile bridge / DPoP-Nonce / webhook AAD / integration test) per user direction to integrate 5 additional external findings into the same PR. Round-1's 22 findings (3 experts × 8 / 6 / 8) all resolved in the revision.

**Round 2 → Freeze**: Round 2 produced 22 new findings (F9-F17, S7-S12, T9-T15). 9 Majors applied to plan: F10 (iOS helper reuse), F14 (AAD UTF-8), F17 (CI gate downgrade), S7 (uniform error response), S8 (AAD table-name binding), S9 (AAD version binding), T10 (CAS integration test), T11 (row-swap test split), T12 (C10 infra mocks). 13 Minor / deferred-Major findings tracked in plan's "Round-2 Plan-Review Resolution Summary" section for Phase 3 verification.

## Functionality Findings — Round 2

### Resolved from Round 1
F1-F8 all resolved (callsite count, C4 forbidden patterns, C4 layer ambiguity, C5 orderBy enumeration, C1 guard position, D-1 reverse direction, DELETE path asymmetry, dcr-cleanup-worker SLA).

### New in Round 2
- **F9** Minor: dcr-cleanup-worker SLA threshold unspecified → DEFERRED (operational, tracked in PR description)
- **F10** Major: iOS Swift jwkThumbprint should reuse existing `exportPublicKeyJWK` helper → **APPLIED to D-6**
- **F11** Minor: device_jkt Zod length is shape gate, not semantic → DEFERRED (implementer judgment)
- **F12** Minor: near-expiry CAS race false rejection → DEFERRED (implementer judgment)
- **F13** Minor: nonce.test.ts deletion grep collision with self-test → DEFERRED (code review)
- **F14** Major: AAD UUID hex-strip is fragile → **APPLIED to D-9 (UTF-8 encoding)**
- **F15** Minor: secretAadVersion @default(1) is silent-bypass risk → DEFERRED (future PR may flip default after migration)
- **F16** Minor: jwkThumbprint extraction is already done; C10 contract has dead text → DEFERRED (implementer reads existing code)
- **F17** Major: C2 test-mock CI regex is non-deterministic → **APPLIED (downgraded to reviewer-enforced)**

## Security Findings — Round 2

### Resolved from Round 1
- S1 (D-1 reverse direction) → resolved by symmetric guards (I-C1-1 + I-C1-2)
- S2 (audit exactly-once) → resolved (audit fires unconditionally after step-2)
- S3 (`.delete` vs `.deleteMany`) → resolved (I-C5-5 mandates deleteMany)
- S4 (prompt injection mitigation) → PARTIALLY resolved; sanitization added at storage boundary; residual S10 + S11 remain
- S5 (worker SLA hint) → resolved (503 response includes `dcr-cleanup-worker` literal)
- S6 (tool description constant) → resolved (USER_SUPPLIED_METADATA_WARNING exported)

### New in Round 2
- **S7** Major: C7 differentiated error responses leak bridge-code validity oracle → **APPLIED to D-7 (uniform MOBILE_BRIDGE_CODE_INVALID)**
- **S8** Major: C9 AAD does not bind table identity → **APPLIED to D-9 (tableName prefix)**
- **S9** Major: C9 v1 legacy path is downgrade oracle → **APPLIED to D-9 (version in AAD)**
- **S10** Minor: C4 sanitization reject-list omits U+2028/U+2029, zero-width chars, BOM → DEFERRED (implementer extends reject-list)
- **S11** Minor: tools.ts projector call-site not explicitly enforced → DEFERRED (code review verifies)
- **S12** Minor: C8 conditional deletion of nonce.ts → DEFERRED (code review enforces mandatory deletion)

## Testing Findings — Round 2

### Resolved from Round 1
T1-T8 all resolved (C4 patterns, C2 fn(fakeTx), C5 invocationCallOrder, C4 constant import, C1 mock-call-count, R21 re-run path, scripts/checks/check-bypass-rls.mjs, C3 integration test names).

### New in Round 2
- **T9** Major: C8 acceptance lacks explicit `toBeNull()` for DPoP-Nonce header → DEFERRED (code review)
- **T10** Major: C7 concurrent test must be integration tier → **APPLIED to C7 acceptance**
- **T11** Major: C9 row-swap "decrypt FAILS" ambiguous → **APPLIED to C9 acceptance (split crypto + dispatcher)**
- **T12** Major: C10 Redis/jti-cache dependency → **APPLIED to C10 (I-C10-1 allows infra doubles)**
- **T13** Major: C9 forbidden-pattern regex fragile → DEFERRED (AST check out of scope; reviewer-enforced)
- **T14** Minor: C6 negative test for legacy device_pubkey → DEFERRED (code review adds)
- **T15** Minor: C5 logger.warn assertion → DEFERRED (code review adds)

## Adjacent Findings

- F1/T2: callsite count + test-mock migration risk (cross-expert overlap, addressed in C2 + I-C2-2)
- T10/F12: CAS integration tier vs near-expiry edge case (overlap; both addressed)

## Recurring Issue Check (consolidated round-2 results)

### Functionality expert
- R1-R8: round-1 resolutions stand
- R9 (deferred SLA): F9 open (operational, not blocking)
- R10 (iOS feasibility): F10 applied
- R11 (Zod-as-semantic): F11 open (acceptable)
- R12 (CAS edge): F12 open (low frequency)
- R13 (self-test grep collision): F13 open (code review)
- R14 (AAD encoding fragility): F14 applied
- R15 (default-value safety net): F15 open (future PR)
- R17 (regex gate non-determinism): F17 applied

### Security expert
- R10 (deleteMany idempotence): resolved (S3)
- R11 (orderBy enforcement): resolved (I-C5-4)
- R19 (no AAD in legacy GCM): S9 applied
- R32 (no schema downgrade path): S9 applied
- R34 (Bidi/Unicode safety): S10 open (extended in implementation)
- R35 (table-name in AAD): S8 applied
- R36 (CAS oracle leakage): S7 applied
- R37 (dead code removal): S12 open (mandatory deletion at code review)
- RS4 (no migration shim if pre-1.0): OK

### Testing expert
- R3 (unmocked dependency drift): T12 applied
- R4 (forbidden-pattern grep precision): T13 open (out of scope)
- R5 (negative-path coverage): T14 open (code review)
- R14 (dead test mock removal): T9 open (code review)
- R15 (ambiguous "fail" assertion): T11 applied
- R16 (concurrent test unit vs integration): T10 applied
- R23 (forbidden-pattern false negatives): T13 open
- R29 (DPoP nonce removal completeness): T9 open

## Quality Warnings

None — no findings flagged VAGUE / NO-EVIDENCE / UNTESTED-CLAIM in either round.
