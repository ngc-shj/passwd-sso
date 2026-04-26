# Plan Review: proxy-csrf-enforcement

Date: 2026-04-26
Review rounds: 4 (converged — only Minor prose findings in Round 4)

## Background

This plan replaces the abandoned `centralize-route-guards-plan-superseded.md`
(which over-engineered with HOF wrappers + CI scanner). The replacement
addresses the same root cause (R3 baseline: 9 session-mutating routes lack
`assertOrigin`) by moving CSRF defense to the proxy layer (single ingress
point) instead of per-route migration.

Sub-agent reviews ran in parallel for each round. Rounds 1 & 2 also had
inline review fallbacks during a temporary org usage limit.

---

## Round 1 — Initial Review

### Functionality Findings

**[F1] Major — `assertSessionCsrf` placed inside `policy.kind === "api-session"` branch, missing `/api/internal/audit-emit`** (the pre1 case)

- The proxy's session-required path list (`src/proxy.ts:270-292`) does NOT include `/api/internal/*`. The plan's gate gated to "api-session" classification would not fire for audit-emit.
- **Resolution**: gate moved to request-attribute basis (`hasSessionCookie + mutating method`), path-independent. Closes pre1 structurally.

### Security Findings

**[S1] Major — proxy's internal fetch (`src/proxy.ts:153`) sends cookie but no Origin header**

- Node fetch (undici) does not auto-set Origin. After CSRF gate added, the proxy's own self-fetch to `/api/internal/audit-emit` would be blocked.
- **Resolution**: explicit `Origin: <self-origin>` added to proxy's internal fetch headers. Logical same-origin declared.

### Testing Findings

**[T1, T2] Minor** — depended on F1/S1; resolved when those resolved.

---

## Round 2

### Resolved
- F1, S1, T1, T2 — all Resolved.

### New Findings

**[F2] Minor — `/api/csp-report` may 403 logged-in users in sandboxed contexts**

- CSP reports may carry `Origin: null` from sandboxed iframes. Logged-in user's session cookie + null Origin → CSRF gate would 403 the report.
- **Resolution**: `route-policy.ts` adds `public-receiver` discriminant for csp-report. Orchestrator returns NextResponse.next() before CSRF gate.

**[S2] Minor — naming inconsistency: `api-bearer` vs `api-bearer-bypass`**

- Plan body used both spellings. TypeScript discriminated-union narrowing requires exact match.
- **Resolution**: normalized to `api-bearer-bypass` throughout.

**[S3] Minor — Bearer + session cookie + bad Origin order change undocumented**

- Developer scenario (signed in to web app while testing extension): request carries both extension Bearer AND stale session cookie + chrome-extension:// Origin. New behavior: 403 from CSRF gate (cookie precondition met).
- **Resolution**: R1 risk extended with case 2; C4 step 6 test case added.

**[T3] Minor — counter-test for internal fetch missing**

- Without test, future refactor could silently drop the Origin header.
- **Resolution**: C4 step 6 adds counter-test "internal fetch WITHOUT explicit Origin → 403".

**[T4] Major — C5 originally removed inline `assertOrigin` from cookieless pre-auth routes**

- Pre-auth routes (passkey/options, options/email, verify, extension/bridge-code) don't carry session cookies. After C5 removal AND with proxy gate having `hasSessionCookie` precondition, they'd have no Origin defense.
- **Resolution**: C5 split into 21 REMOVE (cookie-bearing) + 4 KEEP (pre-auth). Responsibility Boundary table updated: Route layer is responsible for Origin enforcement on cookieless pre-auth routes.

**[Test R7] Minor — C5 needs explicit enumeration of test files with active CSRF-403 assertions**

- 13 test files would break without explicit migration list.
- **Resolution**: C5 enumerates the affected test file:line pairs.

---

## Round 3

### Resolved
- F2, S2, S3, T3, T4, R7 — all Resolved.
- Re-verification of route classifications: `extension/bridge-code` was misclassified as "pre-auth keep" in Round 2 — actually requires session per its `await auth()` at line 43. Moved to REMOVE list. Final split: **21 REMOVE + 3 KEEP** (passkey only).

### New Findings

**[F3] Major — orchestrator `public-receiver` early-return positioned AFTER the CSRF gate, contradicting C3 prose**

- Orchestrator code put `public-receiver` after the gate; F2 fix incomplete because logged-in CSP report submitter would still 403.
- **Resolution**: orchestrator re-ordered. ALL non-CSRF early-returns (`preflight`, `public-share`, `public-receiver`, `api-v1`) precede the CSRF gate. Critical-ordering note added.

**[S4] Minor — `api-v1` + stale session cookie undocumented 403 false-positive**

- API key REST call from a developer with stale session cookie → CSRF gate fires (cookie present), 403 before api-v1 reaches handler.
- **Resolution**: `api-v1` added to non-CSRF early-returns (before CSRF gate). C4 step 6 test case added. R1 risk extended with case 3.

**[T5, T6] Minor — stale counts in R1/R2 risks ("13 tests", "24 routes")**

- **Resolution**: corrected to "10 files, 11 it-blocks" / "21 REMOVE-list routes". Duplicate R2 deleted.

### Adjacent
- Naming: `RoutePolicy` union vs orchestrator `policy.kind` — normalized to `api-session-required` consistently.

---

## Round 4 — Verification Pass (final round before close)

### Resolved
- F3, S4, T5, T6 — all Resolved.

### New Findings (all Minor — prose/code consistency)

**[F4] Minor — C4 step 2 prose forgot to extend with `public-receiver` and `api-v1` early-returns**

- The orchestrator code was correct, but the prose listing the insertion point only mentioned `preflight/public-share`. An implementer following step 2's prose strictly could miss the new early-returns.
- **Resolution**: C4 step 2 prose extended to list all 4 (`preflight/public-share/public-receiver/api-v1`).

**[S5] Minor — `/api/v1/openapi.json` uses `authOrToken` (accepts session) — exception not noted in C3**

- Most v1 routes use `validateV1Auth` (Bearer-only); `openapi.json` is the exception. Not a security issue (GET, no sensitive data, method-gated out of CSRF), but worth documenting.
- **Resolution**: C3 adds the openapi.json exception note.

**[T7] Minor — Testing Strategy summary still listed only 4 proxy.test.ts cases vs C4 step 6's 11**

- Stale duplicate listing.
- **Resolution**: Testing Strategy summary replaced with cross-reference to C4 step 6 as authoritative source. Single source of truth.

### Adjacent
- `authOrToken` order (session before Bearer) — affects audit `actorType` for sessions-with-Bearer-key requests. Out of scope for this plan but flagged.

---

## Recurring Issue Check (consolidated, all rounds)

| ID | Status |
|----|--------|
| R1 (utility reimpl) | OK — delegates to existing `assertOrigin`, `rate-limit`, etc. |
| R3 (pattern propagation) | **Closed structurally** — proxy CSRF gate is path-independent; no per-route enumeration needed |
| R10 (circular import) | OK — `src/lib/proxy/*` → existing primitives, no reverse |
| R13 (re-entrant audit dispatch) | OK — proxy self-fetch handled via S1 fix (Origin set explicitly) |
| R17 (helper adoption coverage) | OK — 21 routes enumerated, 3 KEEP routes' rationale documented |
| R20 (mechanical edits) | OK — C5 is symmetric removal pattern |
| R29 (citation accuracy) | OK — no RFC citations in this plan |
| RS1-RS3 | OK — no new auth/timing-safe surfaces |
| RT1-RT3 | OK — mocks aligned, test infra parity addressed in C5 |

---

## Final Resolution Status (Phase 1)

All 4 rounds yielded:
- **0 Critical**
- **5 Major** (F1, F3, S1, T4 → all resolved; original Round 1 F1/S1 + Round 2 T4 + Round 3 F3)
- **12 Minor** (all resolved)
- **3 Adjacent** (informational, deferred or accepted)

Plan is ready for implementation. Six commits land on `refactor/proxy-csrf-enforcement`:

1. **C1** — Extract `security-headers.ts`
2. **C2** — Extract `auth-gate.ts`
3. **C3** — Extract `cors-gate.ts` + `route-policy.ts`
4. **C4** — Add `csrf-gate.ts` + wire orchestrator + fix internal fetch
5. **C5** — Remove inline `assertOrigin` from 21 cookie-bearing routes (keep 3 pre-auth)
6. **C6** — Document responsibility boundary in CLAUDE.md

## Out of Scope (Plan B — separate PRs)

F2, F1/S3 (audit constant), F3/dryRun audit, F4 FIFO eviction, S1 audit-emit Zod, S2 CSP form-action, T1-T4 test infra. See Plan B notes in plan body.

## Genuinely Deferred (require separate redesign)

- pre2 — 30s session-revocation cache bypass (Redis redesign)
- pre3 — `operatorId` body field vs token-bound claim (signed-token redesign)

---

## Phase 3 (Code Review) Summary

Three review rounds against the implemented branch (10 commits).

### Round 1 — Initial review (after C1-C6 + lint fix)

- **Major**: T1 — proxy.test.ts had 0 of 11 plan-specified CSRF integration tests.
- **Minor**: F1 (proxy.ts size > 100 lines target), F2 (mcp/authorize/consent comment), T2 (TTL test missing), T3 (SESSION_CACHE_MAX literal), T4 (11 orphan vi.mock declarations).
- **Structural concern (raised by user, not by experts)**: orchestrator OR `policy.kind === API_SESSION_REQUIRED || API_BEARER_BYPASS` was a symptom that `api-bearer-bypass` was the wrong primitive. Bypass is a code-path concern, not a classification concern.
- **Resolution** (commit `1cbf534e`):
  - Drop `API_BEARER_BYPASS` kind; bypass routes classify as `api-session-required`. orchestrator uses `isBearerBypassRoute(pathname)` directly.
  - Add 11 CSRF integration tests + auth-gate TTL test to proxy.test.ts.
  - Replace `SESSION_CACHE_MAX = 500` literal with import.
  - Sub-agent cleaned 11 orphan vi.mock declarations.
  - F1 accepted (proxy.ts page-route logic is intentionally retained).
  - F2 accepted (proxy CSRF gate makes the consent route's `if (!origin)` defense-in-depth, not misleading).

### Round 2 — Verification of Round 1 fixes

- **Minor**: F3 (`classifyRoute` had redundant `isBearerBypassRoute` import — dead code), T5 (TTL test used `30_000` literal), T6 (one orphan vi.mock missed in Round 1: `src/__tests__/api/tenant/breakglass.test.ts`).
- **Resolution** (commit `fb012ea7`):
  - F3: drop `isBearerBypassRoute` import from route-policy; module is now pure pathname-only classifier.
  - T5: import `SESSION_CACHE_TTL_MS`; use `TTL/6` and `TTL` instead of `5_000`/`30_000`.
  - T6: clean orphan vi.mock + `mockAssertOrigin` from breakglass.test.ts.

### Round 3 — Final verification

- **All experts: No new findings**. Convergence achieved.

### Test count progression

- Pre-branch: 7317 passed, 1 skipped
- After C1-C6: 7317 (unchanged — only deletions in C5 + 1 fixture update in C4)
- After Round 1 fixes (`1cbf534e`): 7329 (+12 — 11 CSRF integration tests + 1 TTL test)
- After Round 2 fixes (`fb012ea7`): 7329 (unchanged)

### Final state

- Lint: pass (0 warnings)
- Tests: 7329 passed, 1 skipped, 0 failed
- Build: pass
- Commits on branch: 11 (Phase 1 plan + C1-C6 + lint fix + Round 1 fix + Round 2 fix)
