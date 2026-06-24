# Code Review: admin-stepup-nostore-hardening
Date: 2026-06-24
Review rounds: 2 (+ user-finding integration)

## Changes from Previous Round
- Round 1: full-diff review by 3 experts (Ollama seeds timed out → full-diff fallback) + 5 user findings integrated.
- Round 2: incremental verification of the Round-1 fixes (bypass-rls, 6 new step-up gates, URL masking).

## Functionality Findings
- **F1 (Minor, resolved)**: 5 migrated no-store routes lacked a `Cache-Control` header assertion in their tests → added.
- **F-R2-1 (Minor, accepted cosmetic)**: policy/route.ts transaction body over-indented by 4 spaces after the nested-`$transaction` removal. Valid, compiles, lint-clean; re-indenting for zero functional gain rejected as churn.

## Security Findings
- **S1 (Major, resolved — user: all routes)**: `members/[userId]` PUT performs OWNER→OWNER ownership transfer (highest privilege) without step-up. Gate added.
- **S2/S3 (Minor→resolved)**: reset-vault POST, audit-delivery-targets POST + [id] PATCH lacked step-up (exfil-sink config). Gates added.
- **S4 (Minor, resolved — user: all routes)**: breakglass POST + [id] DELETE lacked step-up. Gates added.
- **User finding (Medium, resolved)**: `check:bypass-rls` CI gate failed on the Phase-2 D2 lint fix. Root-caused and fixed (removed redundant nested `$transaction`, use bypass `tx` directly).
- **User finding (Medium, resolved)**: audit-delivery URLs accepted embedded credentials, leaked via GET + 3 worker log sites. `isSsrfSafeWebhookUrl` now rejects userinfo; `maskUrlForDisplay` (origin+pathname) applied to list response + logs; delivery still uses full URL.
- **User finding #2 (Medium, resolved)**: `extension/token/refresh` returned a plaintext token without no-store (C2 enumeration miss). Added.
- **S-R2-1 (Minor, accepted)**: lost `Serializable` isolation on the policy team-clamp transaction. Tenant-scoped, trusted OWNERs, self-heals — see deviation D5.
- **S-R2-5 (Minor, resolved)**: audit-delivery [id] PATCH parsed body before step-up → moved after (canonical order).
- **S-R2-12 (Minor, unreachable — noted)**: `sanitizeErrorForStorage` blind to userinfo in error strings, but ingestion gate now blocks credentialed URLs. Defense-in-depth note only.

## Testing Findings
- **T-R2-4 (Major, resolved)**: 3 tuple-type annotations `([, msg]: [unknown, string])` in audit-delivery.test.ts broke `tsc --noEmit` (vitest transpiles without type-check → suite passed but typecheck gate would fail). Annotation dropped.
- **T-R2-1 / T-R2-3 (Minor, accepted)**: centralized members/breakglass tests have step-up pass-through mocks but no reject test. Reject path covered non-vacuously in route-local tests (`.not.toHaveBeenCalled()` on the mutation spy). Duplicating = churn.
- All C3 reject tests confirmed non-vacuous (drive past authz+existence, assert mutation-not-called). C4 denial test is a true regression guard. URL-masking tests load-bearing (fetch-full-URL assertion proves delivery unbroken).

## Recurring Issue Check
- **R3 (propagation)**: clean (mechanical check 0 findings); the step-up asymmetry sweep that drove the user's "all routes" decision was the R3/R34 result. R19 mock-alignment: every test importing a gated handler mocks the helper (verified by sweep + full suite).
- **R17/R22 (helper adoption)**: `NO_STORE_HEADERS` adopted across the full secret-bearing class (incl. the 2 self-R-check catches + extension/refresh + webhooks). No inline no-store survives at any non-infra secret route.
- **R31 (destructive DELETE ordering)**: all gated DELETE handlers — authz → existence → step-up → delete.
- **RS1 (timing-safe)**: C4 reorder introduced no `===` on secret material.
- **CI-gate parity**: the bypass-rls miss exposed that the local lint/test/build set is a subset of CI. Resolved by running all 6 `check:*` gates + `tsc --noEmit` + `scripts/pre-pr.sh` (38 checks, all pass).

## Environment Verification Report
- **VC1** (bridge-code consume/network ordering, C4): `verified-local` — the denial-path "code not consumed" regression (`mockMobileBridgeCodeUpdateMany` NOT called) runs in the unit suite and fails on pre-reorder code. The full real-DB retry leg remains `blocked-deferred` per the Phase-1 VC1 constraint (mocked Prisma has no `usedAt` state) — Anti-Deferral justification recorded in the plan's VC1 entry.

## Resolution Status
All Critical/Major findings resolved. Minors either fixed or accepted with documented justification (deviation D5–D8). Final verification: `scripts/pre-pr.sh` 38/38 pass; full suite 11677 pass; tsc clean; all 6 `check:*` CI gates pass.

## Round 3 termination
The only post-Round-2 changes were the T-R2-4 type-annotation fix (test-only, now type-clean) and the S-R2-5 parseBody reorder (security-boundary, but minimal and reviewed). Both confined to prior-round fix scope; the parseBody reorder verified by 26 passing audit-delivery tests + full pre-pr. No new findings warrant a Round-3 sub-agent pass. Termination condition met.
