# Plan Review: fail-closed-sc-t3-remaining
Date: 2026-07-20
Review round: 1 (findings applied; round 2 verification below)

## Changes from Previous Round
Initial review. Local LLM pre-screen: "No issues found." Three expert
sub-agents (Functionality / Security / Testing) reviewed in parallel.

## Merged Findings (deduplicated)

| ID | Source | Severity | Finding | Resolution (applied to plan) |
|----|--------|----------|---------|------------------------------|
| M-F1 | Func F1 | Minor | SC1 justification cited `rateLimited()` which the SCIM 429 path never calls; `rl.retryAfterMs` IS available, just unwired | SC1 rewritten: RFC-silence + unrequested-spec-change is the sole rationale; factual note on unwired plumbing added |
| M-F2 | Func F2 + Sec [Adjacent] (2-expert convergence) | Minor | Hardcoded "42 scimError call sites" count wrong (independent greps: 41-43) | Count removed; criterion now "all call sites, via next build + grep audit" |
| M-F3 | Test F1 | Minor | C1 cited non-existent `mockEntryFindFirst`; actual mock is `mockEntryFindUnique` ([id]/route.test.ts:8,44) | Plan corrected to `mockEntryFindUnique` with line refs |
| M-F4 | Test F2 | Major (JSON index; prose said Minor/Moderate — adjudicated up) | C4 real-Redis IP-limiter (5/min) cross-case pollution mitigation not pinned (IPs unenumerated, CI-retry unconfirmed, token-key cleanup implicit) | Reserved IPs 203.0.113.30/.31 (verified unused; in-use set enumerated); verified no `retry` in either vitest config; token-key cleanup rationale made explicit (green: never lands on real Redis; red: delete in afterEach) |
| M-F5 | Sec [Adjacent] | Minor | C4 red-proof 404 should be guaranteed by construction | Fresh/random token per case added to the contract |
| M-F6 | Func F3 + Test F3 [Adjacent] | Minor | Selective wrapper `del` branch unreachable in the two cases; routing robustness question | Security expert independently confirmed routing sound (disjoint namespaces, falsifiable red-proof); plan now documents `del` as defensive scaffolding + afterEach cleanup use |

## Functionality Findings
F1 (Minor, applied), F2 (Minor, applied), F3 (Adjacent → M-F6). Notable
verifications: factory-args-match uniqueness vs migrateLimiter confirmed;
consumer-flow walkthrough (C2) adequate; R42 member-set independently
re-derived (exactly 5 members).

## Security Findings
No findings. Verified: INV-C2 member-set complete (5/5, independent
recomputation; non-member 503 sites classified); C2 header-injection defense
(spread order) sound; C3 anti-enumeration preserved on both branches, PII
forbidden-pattern sufficient; C4 wrapper cannot false-green (red-proof
falsifiability); C1 identity-based factory attribution cannot mask silent
fail-open regression. R29: citations accurate, permission-only framing
correct. Two [Adjacent] Minors → M-F2, M-F5.

## Testing Findings
F1 (Minor, applied), F2 (Major, applied), F3 (Adjacent → M-F6). Notable
verifications: both v1 test files use vi.clearAllMocks() (snapshotFactory
trap real); wrapper surface = complete production Redis surface
(rate-limit.ts:60-106); retryAfterSecondsOrDefault indirectly covered
(api-response.test.ts:82-124); C8a logger doMock shape supports the new
mockError assertions without new mock surface.

## Adjacent Findings
All three [Adjacent] items merged above (M-F2, M-F5, M-F6); none unrouted.

## Quality Warnings
None — merge quality gate reported no VAGUE / NO-EVIDENCE / UNTESTED-CLAIM
findings.

## Severity-index discrepancy note
Testing expert's F2 prose header said "Minor" (impact "Moderate") while its
JSON index said "Major". Orchestrator adjudicated to Major (stricter) and
applied the full recommended action rather than round-tripping — the fix was
cheap and complete either way.

## Recurring Issue Check
## Recurring Issue Check
### Functionality expert
- R1: pass — all four contracts reuse existing helpers; no reimplementation
- R2: pass — 30s default centralized via retryAfterSecondsOrDefault export; forbidden pattern blocks new "30" literal in scim/
- R3: pass — C1 migrates all 3 legacy cases, not a subset
- R4: n/a; R5: n/a (no DB writes); R6: n/a; R7: n/a; R8: n/a; R9: n/a
- R10: pass — no new import cycle (verified)
- R11-R15: n/a
- R16: pass — C4 gated by VE1+VE2, available locally and in CI
- R17: pass — factory-args-match unique against migrateLimiter
- R18: n/a
- R19: pass — verified against actual current mock shapes
- R20: n/a; R21: n/a (plan-stage)
- R22: pass; R23: n/a; R24: n/a (no migration); R25: n/a; R26-R28: n/a
- R29: finding F1 — not RFC-text accuracy, but plan's application of the rationale to code
- R30: n/a; R31: n/a; R32: n/a; R33: n/a
- R34: pass — SC2 deferred with explicit owner/follow-up note
- R35: pass — VE3 documents SCIM real-IdP gap with cost-justification
- R36: n/a; R37: n/a (log channels are operator-facing)
- R38: pass — redisErrored implies allowed:false; new branch correctly ordered first
- R39: n/a
- R40: pass — C2 consumer-flow walkthrough covers all 3 consumers adequately
- R41: n/a
- R42: pass — independently re-derived; exactly 5 members; other raw 503 sites are unrelated failure classes
- R43: n/a; R44: n/a; R45: n/a
- R46: pass — factory calls structurally distinguishable on max/failClosedOnRedisError

```json
[
  {"id":"F1","severity":"Minor","title":"SC1's stated justification (rateLimited() only sets Retry-After when known) doesn't match the actual SCIM 429 code path, which never uses rateLimited()","file":"docs/archive/review/fail-closed-sc-t3-remaining-plan.md","line":343,"adjacent":false,"escalate":null},
  {"id":"F2","severity":"Minor","title":"Acceptance criteria count of '42 existing scimError call sites' is off by one from actual grep count (41)","file":"docs/archive/review/fail-closed-sc-t3-remaining-plan.md","line":205,"adjacent":false,"escalate":null},
  {"id":"F3","severity":"Minor","title":"C4 selective-Redis-wrapper command-routing robustness against false negatives is adjacent to security/test-design review","file":"src/__tests__/db-integration/rate-limit-fail-closed-routes.integration.test.ts","line":null,"adjacent":true,"escalate":null}
]
```

## Recurring Issue Check
### Security expert
- R1: pass — C2 reuses retryAfterSecondsOrDefault as single owner; forbidden-pattern gate enforces
- R2: pass — 30s default single-sourced
- R3: pass — C1 completes propagation to last 3 legacy cases; C2 completes 5-member invariant
- R4-R8: n/a
- R9: n/a
- R10: n/a — import direction unchanged
- R11-R28: n/a
- R29: pass — citations verified accurate; permission-only framing
- R30: n/a
- R31: n/a
- R32-R37: n/a
- R38: pass — no fail-open supersession; all contracts narrow/observe fail-closed behavior
- R39: n/a
- R40: n/a
- R41: n/a
- R42: pass — INV-C2 member-set independently recomputed, 5/5 complete
- R43: pass — headers param additive-optional, Content-Type non-overridable; no boundary widening
- R44: n/a
- R45: n/a
- R46: pass — selective wrapper scoped to exact disjoint key namespace
- RS1: n/a — no credential/token comparison touched
- RS2: n/a — no new routes
- RS3: n/a — no new request-derived input (headers param internal-caller-only)
- RS4: pass — forbidden-pattern bars identifier/email in new log call
- RS5: pass — retryAfterSecondsOrDefault clamps to fixed default; no untrusted input reaches it
- RS6: pass — header spread-order forbidden pattern is the correct ordering

```json
[]
```

## Recurring Issue Check
### Testing expert
- R1: pass; R2: pass; R3: n/a; R4-R15: n/a
- R16: pass — VE1/VE2 verified locally + CI (REDIS_URL at ci-integration.yml:78)
- R17: n/a; R18: n/a
- R19: pass — pipeline().incr/pexpire/pttl/exec + del confirmed as the complete production Redis surface used by createRateLimiter (rate-limit.ts:60-106)
- R20: n/a; R21: n/a (review independently re-read all cited files); R22-R28: n/a
- R29: pass — internally consistent
- R30-R41: n/a (R34/R35 covered by other experts)
- R42: pass — 5-member set spot-checked; cited line numbers all matched real source
- R43-R46: n/a
- RT1: pass — both v1 test files DO use vi.clearAllMocks() in beforeEach (snapshotFactory trap is real); v1ApiKeyLimiter/migrateLimiter both constructed in rate-limiters.ts (premise holds)
- RT2: pass
- RT3: pass
- RT4: finding F2 — IP pollution mitigation not pinned
- RT5: pass — forbidden patterns bar limiter mocking; with-scim-auth.test.ts deliberately does not mock rate-limit-audit
- RT6: pass — retryAfterSecondsOrDefault covered indirectly via api-response.test.ts:82-124; response.test.ts new headers-param coverage exercises it at the scimError boundary
- RT7: pass — Content-Type-unoverridable negative falsifiable; C4 red-proof mirrors existing passing pattern (:231-257)
- RT8: pass — sendEmail/mutation spy asserted on both C3 branches; existing logger doMock shape supports mockError without new mock surface
- RT9: pass — no twin implementation applicable

```json
[
  {"id": "F1", "severity": "Minor", "title": "C1's assertNoMutation description cites non-existent mockEntryFindFirst instead of actual mockEntryFindUnique", "file": "docs/archive/review/fail-closed-sc-t3-remaining-plan.md", "line": 127, "adjacent": false, "escalate": null},
  {"id": "F2", "severity": "Major", "title": "C4 real-Redis IP-limiter (5 req/min) cross-case pollution risk not fully pinned by the plan's stated mitigation", "file": "src/__tests__/db-integration/rate-limit-fail-closed-routes.integration.test.ts", "line": null, "adjacent": false, "escalate": null},
  {"id": "F3", "severity": "Minor", "title": "C4 selective wrapper's del/clear routing may be unreachable in the two new test cases as scoped", "file": "src/app/api/share-links/verify-access/route.ts", "line": null, "adjacent": true, "escalate": null}
]
```

---

# Round 2 (verification of applied fixes)
Date: 2026-07-20

## Changes from Previous Round
All 6 merged Round-1 findings (M-F1..M-F6) applied to the plan: SC1 rewrite,
call-site count removal, mockEntryFindUnique correction, C4 fresh-random
token, C4 reserved IPs 203.0.113.30/.31 + no-vitest-retry verification +
token-key cleanup rationale, C4 del-branch documentation.

## Functionality Findings
No findings. All six fixes verified against plan text and source; references
accurate (mockEntryFindUnique at [id]/route.test.ts:8,44; existing assertion
:167-177); no regressions in INV-C2 member-set, consumer walkthrough, C3
branch ordering, Go/No-Go gate. json index: [].

## Security Findings
No findings. SC1's retryAfterMs note verified safe (server-computed, bounded
by windowMs, inherits retryAfterSecondsOrDefault clamp if ever wired — no
RS5 concern). IPs .30/.31 independently confirmed unused; no vitest retry;
token-key cleanup asymmetry correct (no orphaned real-Redis key from green
case). Both Round-1 Adjacent Minors resolved. json index: [].

## Testing Findings
No findings. F1/F2/F3 verified resolved against live source and config
(in-use IP set matches grep; no retry in configs, CLI, or CI wrapper;
random 64-hex token satisfies hexHash schema at
src/lib/validations/share.ts:125). RT4 fully closed; RT7 strengthened by the
randomized-token fixture. json index: [].

## Convergence
All three experts returned "No findings" in Round 2. Plan review complete
after 2 rounds. All contracts C1-C4 remain `locked`.
