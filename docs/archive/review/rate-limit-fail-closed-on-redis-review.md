# Plan Review: rate-limit-fail-closed-on-redis
Date: 2026-05-17
Review round: 4 (CONVERGED — Plan ready to lock)
Total rounds: 4

## Round 4 — Final Convergence

Single-agent verification confirmed: all Round 3 fixes correctly applied, no new contradictions or regressions, plan internally consistent across C1/C2/C2b/C3/C4/C5/C6. Final verdict: **CONVERGED — no new findings**.

## Round 3 — Fixes Applied

After Round 2 was closed with 11 findings resolved, Round 3 surfaced 7 additional issues — all addressed:
- F20 Medium: count formula error (38+4×2=46) — FIXED
- F21 Medium: row 6 mismatch (vault/admin-reset ≠ reset-vault initiate) — FIXED with deliberate-exclusion note
- F22 Low: AC4.3 path formula contradicts example — FIXED with precise rule + alternative-match fallback
- S14 Medium: forbidden-pattern allowlist incomplete (3 sites missing + 1 line number) — FIXED with expanded allowlist
- T17 High: AC4.3 formal rule vs example contradiction — FIXED via merged F22/S13 resolution
- T18 Medium: AC3.8 test pattern doesn't actually exercise LRU eviction — FIXED to 10_001 entries + re-touch
- T19 Medium: manual-test SQL used quoted camelCase column refs (Prisma maps to snake_case) — FIXED throughout



## Round 2 — Changes from Previous Round

All Round 1 findings (F1-F15, S1-S10, T1-T12) substantively resolved in the plan revision. Round 2 expert verification found 10 additional Minor + 2 Major issues, all addressed in the second plan revision (commits at this point).

## Round 2 Functionality Findings (status)

All Round 1 F-IDs RESOLVED. Round 2 NEW:
- **F16 Minor**: Considerations-4 arithmetic (13 user routes + 23 adjacent + 6 S2 = 42, not "14+35+6") — FIXED in plan revision.
- **F17 Minor**: `RateLimitProbe` inner interface widening required in lockstep with outer — FIXED via I1.5 strengthening + forbidden grep updated.
- **F18 Minor**: Scenario A SQL aggregated by tenantId only, could not detect mis-attribution within row — FIXED by querying individual rows.
- **F19 Minor**: ACTOR_TYPE.ANONYMOUS source clarity in I5.1 — FIXED by adding explicit "existing constant; no change" line.

## Round 2 Security Findings (status)

All Round 1 S-IDs RESOLVED. Round 2 NEW:
- **S11 Minor**: C2 forbidden-pattern exception list omitted 7 pre-existing `errorResponse(SERVICE_UNAVAILABLE, ...)` call sites in opt-in routes (RP_ID/config errors) — FIXED by expanding the allowlist to include all 9 verified call sites with rationale.
- **S12 Minor**: `oauthTemporarilyUnavailable` `description` param has no leakage guard — FIXED by dropping the param entirely (YAGNI); future addition would require Forbidden Pattern.
- **S13 Minor**: AC4.3 CI gate semantic ambiguous — FIXED with concrete spec (sibling test path + `redisErrored` literal OR debt-allowlist entry).

## Round 2 Testing Findings (status)

All Round 1 T-IDs RESOLVED except T5 partial. Round 2 NEW:
- **T13 Major**: AC5.4 integration test requires outbox drain not in existing infra — FIXED by splitting into AC5.4a (write-side, this PR) + AC5.4b (drain-side, relies on existing outbox-worker integration test infra).
- **T14 Major**: Scenario D asserts `MCP_AUTHZ_DENIED` audit row that does not exist in the codebase — FIXED with positive-side verification (no `MCP_REFRESH_TOKEN_*` / `MCP_CONSENT_GRANT` rows, no new delegation_sessions).
- **T15 Minor**: AC4.3 script spec too thin (overlaps S13) — FIXED via S13 resolution.
- **T16 Minor**: AC3.8 LRU verification mechanism not specified — FIXED by adding `__getThrottleStateForTests()` to C3 signature.

## Quality Warnings

None — all findings include Evidence + File:line + concrete Fix.

## Recurring Issue Check (Round 2 only — newly-relevant)

### Functionality
- R3 (type safety): F17 GAP → fixed (inner interface widening locked).
- R36 (count attestation): F16 GAP → fixed (arithmetic reconciled).

### Security
- R37 (no internal failure-mode tokens): S12 surface → mitigated (description param removed).

### Testing
- RT4 (integration tests verify post-state): T13 surfaced → fixed (split AC5.4a/AC5.4b).
- R35 (Tier-2 manual test for auth flows): T14 surfaced (broken Scenario D) → fixed.

---

# Round 1 (initial review — preserved for traceability)

## Functionality Findings (Round 1)

[F1] Critical: AUDIT_ACTION_VALUES + group-coverage test gap — RESOLVED in R2.
[F2] Critical: OAuth/DCR envelope incompatibility — RESOLVED via oauthTemporarilyUnavailable helper.
[F3] Major: vault/delegation/check custom envelope — RESOLVED via C4 row #12 CS shape.
[F4] Major: checkIpRateLimit wrapper widening — RESOLVED via I1.5 + AC1.5.
[F5] Major: bespoke envelope route enumeration — RESOLVED via Envelope column in C4.
[F6] Major: forbidden pattern weak — RESOLVED via tightened grep + allowlist + AC2.5.
[F7] Major: AUDIT_SCOPE PERSONAL inconsistency — RESOLVED via I3.4 (always TENANT).
[F8] Major: pre-auth tenantId null dead-letter — RESOLVED via I3.7 (skip emit, warn log).
[F9] Major: AC4.1 incompatible with ~47 mock files — RESOLVED via reduced AC4.1 + AC4.3 grep gate.
[F10] Minor: count consistency — RESOLVED (42 routes / 46 limiters explicit).
[F11] Minor: clear() asymmetry — RESOLVED via I1.4 doc.
[F12] Minor: AC5.4 manual not CI — RESOLVED via AC5.4 integration test.
[F13] Minor: quote 14-route user list — RESOLVED via Considerations-4.

## Security Findings (Round 1)

[S1] Major: SYSTEM vs ANONYMOUS — RESOLVED via I3.5 / I3.6.
[S2] Major: 6 missing credential routes — RESOLVED via C4 rows 37-42.
[S3] Major: scope arg validation — RESOLVED via I3.10 regex + AC3.7.
[S4] Major: throttle-map DoS + webhook fan-out — RESOLVED via I3.2 LRU + WEBHOOK_DISPATCH_SUPPRESS.
[S5] Minor: excluded boundary rationale — RESOLVED via subsection in C4.
[S6] Minor: forbidden pattern for errorResponse(SERVICE_UNAVAILABLE) — RESOLVED + extended in R2.
[S7] Minor: targetType/targetId — RESOLVED via I3.8 + AUDIT_TARGET_TYPE.RATE_LIMITER.
[S8] Minor: bare #470/#472 autolinks — RESOLVED via backticks.
[S9] Minor [escalate true]: no escape valve — RESOLVED via Considerations-11 (no env knob; revert-and-deploy break-glass documented).
[S10] Minor: metadata.ip — RESOLVED via I3.9 ({scope, ip, ipBucket}).

## Testing Findings (Round 1)

[T1] Critical: AC4.1 scope vs 35 routes without tests — RESOLVED via AC4.1 reduced + AC4.3 grep gate (concrete spec in R2).
[T2] Major: 3rd double-limiter file omitted — RESOLVED (4 named).
[T3] Major: audit-action-group-coverage.test.ts in I5.1 — RESOLVED (added to I5.1).
[T4] Major: throttle reset between tests — RESOLVED via __resetThrottleForTests + AC3.2.
[T5] Major: integration test for enum write-through — RESOLVED via AC5.4a (with drain split per T13/R2).
[T6] Major: adversarial scenarios actionable — RESOLVED via spec'd scenarios A-D (with R2 fixes for A and D).
[T7] Major: checkIpRateLimit widening AC — RESOLVED via AC1.5.
[T8] Minor: serviceUnavailable(0) semantics — RESOLVED via AC2.3 NOTE.
[T9] Minor: redisErrored:false in tests — RESOLVED via C1 forbidden pattern.
[T10] Minor: count narrative — RESOLVED (47 not 120).
[T11] Minor: migration commit gate — RESOLVED via AC5.5.
