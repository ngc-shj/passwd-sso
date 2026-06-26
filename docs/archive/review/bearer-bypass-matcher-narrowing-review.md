# Plan Review: bearer-bypass-matcher-narrowing
Date: 2026-06-26
Review round: 1 (initial)

## Changes from Previous Round
Initial review. Three expert sub-agents (functionality / security / testing) reviewed the plan against the codebase. Testing agent's first run hit a transient API socket error; re-run succeeded.

## Functionality Findings
- **F1 (Major) — FIXED in plan**: permanent-delete guard `=== "token"` misses api_key/mcp_token (discriminants are session|token|api_key|mcp_token). Use `!== "session"` (mirrors v1 precedent). Step-up is a backstop regardless.
- **F2 (Minor) — FIXED**: `forbidden()` takes no args; use `errorResponseWithMessage(API_ERROR.FORBIDDEN, msg)`.
- **F3 (Minor) — FIXED**: the two-helper split (isBearerBypassPath for preflight, method-aware isBearerBypassRoute for bypass) is necessary because OPTIONS method ∉ allowlist; api-route.ts must wire both, line 30 reads path-only.
- **F5 (Major) — FIXED**: `cors-gate.test.ts:67` single-arg call is an un-enumerated caller → build break; the truth table must be restructured + several rows flipped. Added to blast-radius + testing strategy.
- **F7 (Minor) — FIXED**: route-policy.ts comments (24/96/155-161) claim cors-gate mirrors its prefix matcher — becomes false; update comments.
- Verified clean: signature change does not break route-policy compilation (comments only); pathname excludes query; access-requests POST/GET method split is expressible.

## Security Findings
- **S1 (Low, == F1) — FIXED**: same as F1; additionally confirmed defense-in-depth — step-up reads session cookie, unsatisfiable by Bearer-only → permanent-delete stays closed for all token types regardless of the explicit guard. Order correct (403 before findUnique/delete).
- **S3 (no finding)**: narrowing is strictly fail-closed — removed (method,path) pairs fall through to session-required 401; no new bypass.
- **S4 (no finding)**: access-requests GET excluded / POST kept is correct; GET was never legitimately Bearer-reachable (session-only handler).
- **S5 (no finding, the win) — note added**: the table is now the structural gate; a future handler scope-migration without a table entry is SAFE (proxy fails closed). Replaced obsolete `S1 LOCKED CONSTRAINT` comment framing. Added a `classifyRoute` regression assertion for an R3 child.
- **S6 (info)**: no audit coverage lost (handlers 401'd before audit anyway).
- No Critical findings → no escalation.

## Testing Findings
- **T1 (High, == F5) — FIXED**: truth-table restructure + row flips (bulk-import, delegation bare, unlock/data/extra, access-requests GET) are false-green traps; enumerated in testing strategy.
- **T2 (Medium) — FIXED**: `isBearerBypassPath` needs its own test block.
- **T3 (Medium) — FIXED**: proxy.test.ts `createApiRequest` can't express method; need method-bearing proxy cases (child/wrong-method → 401, DELETE bypass, child OPTIONS preflight) + classifyRoute assertion.
- **T4 (High) — FIXED**: DELETE token cases must cover ALL non-session types (token/api_key/mcp_token + permanent → 403), token soft-delete → 200, cross-user → 404, plus a scope-wiring assertion (mock is arg-agnostic → otherwise vacuous).
- **T5 (Medium) — FIXED**: ordering test — token+permanent with step-up mocked non-null must yield 403 (guard short-circuits before step-up).

## Resolution Status
All Major findings (F1/S1, F5/T1, T4) reflected in the plan. All Minor/Medium reflected. No Critical. No contract signature/invariant changed — only specifics sharpened, so contracts remain `locked`. Cleared to Phase 2.

## Phase 3 (code review of implementation)
Three experts reviewed the implemented diff.
- **Functionality: No findings.** Verified BEARER_RULES table, `entryUnder` + PASSWORD_SUBROUTES exclusion (all 7 personal + 6 team literals covered), api-route wiring, DELETE guard placement/arity. One Minor note (EXTENSION_TOKEN_ROUTES "Derived" comment) — fixed.
- **Security: No findings.** Exhaustively tested matcher-bypass vectors (trailing/double/encoded slash, case, traversal, subroute-collision) — all fail closed. Permanent-delete double-gated (type guard + step-up backstop). Structural guarantee confirmed: handler scope-migration without a BEARER_RULES entry stays Bearer-unreachable.
- **Testing: 2 Low — both FIXED.** T1: brittle step-up mock restore → moved reset into `beforeEach`, removed manual restore (stable 3× isolated). T2: re-added dropped boundary guards (`/api/teams-export`, `/api/extension/tokenizer`).

Implementation discovery during Phase 2: the naive `[^/]+` single-entry pattern collided with literal subroutes (`bulk-import` etc.) — fixed by `PASSWORD_SUBROUTES` exclusion in both personal (`entryUnder`) and team matchers, with regression cases added.

Final: full suite 11744 passed / 1 skipped; `next build` OK; `pre-pr.sh` exit 0 (38 passed).

## Recurring Issue Check (consolidated)
- R1 (reuse): PASS — reuses checkRateLimitOrFail-style table + existing error helpers (F2 corrected the forbidden() misuse).
- R3 (propagation / all callers): FIXED — cors-gate.test.ts + route-policy comments enumerated (F5/F7).
- R17 (helper adoption): PASS — two-helper split correctly wired (F3).
- RS2 (type checking): FIXED — `!== "session"` over `=== "token"` (F1).
- RT1/vacuous tests: FIXED — row flips, scope-wiring assertion, ordering test (T1/T4/T5).
