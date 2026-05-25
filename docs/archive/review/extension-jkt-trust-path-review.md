# Plan Review: extension-jkt-trust-path
Date: 2026-05-25
Review rounds: 3 (converged)

## Round 1 (initial) — see git history

42 findings; Critical convergence on F1=S1=T6 (CSRF gate misread). v1 unimplementable as written.

## Round 2 — v2 review

v2 introduced 13 contracts (C1-C13) + Go/No-Go gate + Consumer-flow walkthroughs. Most Round-1 findings resolved.

### Round-1 resolution map

- **Func F1-F17**: all resolved by C1-C13 (per Round-2 Func report).
- **Sec S1-S13**: S1 PARTIALLY resolved (see S14), S2-S13 all resolved.
- **Test T1-T12**: 10/12 fully resolved, T11 (SW-side sender check) + T12 (Phase 4 E2E acceptance) partial.

### New findings (Round 2)

#### Critical (convergent S14 + T16)

##### S14 [Critical, escalate:true] / T16 [Critical] — Orchestrator ordering not specified in C2
C2 says "this kind bypasses proxy CSRF gate" but the proxy CSRF gate (`src/lib/proxy/csrf-gate.ts:42-47`) is **request-attribute-based** (cookie + mutating method), NOT classification-gated. Bypass requires the orchestrator (`src/lib/proxy/api-route.ts:54`) to short-circuit BEFORE the CSRF gate fires for `API_EXTENSION_BRIDGE_CODE` (same mechanism as existing `PUBLIC_SHARE` / `API_EXTENSION_EXCHANGE` branches at lines 34-46).

Without this orchestrator addition, the contract `C2` as written reproduces the original S1 failure mode. **Required addition**: explicit invariant + forbidden pattern + proxy.test.ts assertion-shape distinguishing 403-from-CSRF-gate vs 403-from-route-Origin.

##### T14 [Critical] — Race test pattern doesn't match repo precedent
Plan C5 says `Promise.all([POST(req1), POST(req2)])`. Repo precedent for real-DB races (`raceTwoClients` helper at `src/__tests__/db-integration/helpers.ts:297` + N=50 iteration loop in MCP token rotation tests) uses two distinct `PrismaWithPool` instances. `Promise.all` against a single Prisma client serializes on one pg connection — the test passes even with a buggy `update()` (non-CAS) implementation. RT5 violation: the test does NOT exercise the SQL CAS primitive.

#### Major

- **F18**: dead-code list incomplete — `src/lib/inject-extension-bridge-code.test.ts` not in C11 deletion list (test file accompanies C11's `inject-extension-bridge-code.ts` deletion).
- **F19**: `extension/src/lib/api-paths.ts` needs `EXTENSION_BRIDGE_CODE` constant added; not enumerated in C10.
- **F20**: Consumer-flow walkthrough for C4 misses the cnf_jkt persistence chain (bridge-code row → exchange → token row).
- **F21**: C5's `updateMany.where.cnfJkt` predicate semantics unclear — does it use `consumed.cnfJkt` (post-findUnique) or `dpopResult.jkt` (post-verify)? Need to clarify.
- **S15**: residual XSS-triggers-silent-connect deferral acceptable BUT lacks tracking ticket reference.
- **S16**: `cors.ts:45` regex inconsistency — existing `[a-z]{32}` vs v2's `[a-p]{32}`. Tighten cors.ts to `[a-p]{32}` in same PR.
- **S17**: `Access-Control-Allow-Credentials: true` for chrome-extension origin is a new trust boundary; needs forbidden-pattern guard so it's restricted to `API_EXTENSION_BRIDGE_CODE`.
- **S18**: No forbidden pattern preventing future refactor from placing `auth()` ahead of Origin check (could re-expose DB-load DoS).
- **S20**: Audit action `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` not specified; failure-side observability gap.
- **T13**: Manual test scenario #1 not executable (GET_DPOP_JKT not reachable from page DevTools via chrome.runtime.sendMessage).
- **T15**: Classifier ordering — `API_EXTENSION_BRIDGE_CODE` branch must run BEFORE the `startsWith(API_PATH.EXTENSION)` prefix loop in `classifyRoute`.

#### Minor

- F22: C4 step ordering vs C8 proxy-test expectations inconsistent.
- F23: `EXT_CONNECT_PARAM` gating continuity not addressed.
- F24: C9 timeout 8s (vs old 500ms) — needs justification.
- F25: Rollback paragraph doesn't address bridge-code row data during deploy.
- F26: Forbidden pattern regex for schema match.
- S19: `Set<string>` precomputation needs test-time reset helper (e.g. `__resetAllowlistForTests`).
- T17: E2E negative assertion susceptible to phantom-match (R7) — specify HOW it observes.
- T18: Phase 4 + Phase 5 acceptance criteria need explicit test-passing gates.
- T19: C4 order — DPoP verify (expensive EC math) should run AFTER session check (cheap Redis/DB).
- T20: CORS preflight wiring needs explicit `isBridgeCodeRoute` flag in `handleApiPreflight`.
- T21: Document strict-schema rationale (forbid `.passthrough()` / `.catchall()` in future).

### Round 2 Quality Gate

No `[VAGUE]` / `[NO-EVIDENCE]` flags from experts. All findings cite specific files/lines.

### Recurring Issue Check (Round 2)

#### Functionality expert (R-rules)
- R3 (incomplete propagation): RISK — F18 (test file), F19 (api-paths.ts)
- R12 (enum coverage): RISK — discriminated union branch removals in messages.ts (acknowledged but not as forbidden pattern)
- R25 (persist/hydrate): RISK — F20 (cnfJkt persistence chain)
- R37 (TOCTOU): NOTE F21
- Others: OK or N/A

#### Security expert (R + RS-rules)
- R3, R15: OK (resolved by C1)
- R28 (deferred work without ticket): WEAK S15
- R35 Tier-2: RISK T13 (executability gap)
- R-new: NEW (orchestrator ordering invariant missing) — surfaced via S14
- RS1, RS2, RS3, RS4: OK
- Others: N/A

#### Testing expert (R + RT-rules)
- R7 (E2E phantom-match): RISK T17
- R19 (mock alignment): OK
- R35 Tier-2: PARTIAL T13
- RT1, RT3: OK
- RT4 (vacuous-pass guard): PARTIAL — lower bound stated but T14 makes it satisfiable without primitive
- RT5 (test call-path includes primitive): VIOLATION — T14 (Promise.all doesn't exercise SQL CAS)
- Others: N/A

## Round 3 — v3 review

v3 addressed all 24 Round-2 findings (2 Critical + 11 Major + 11 Minor).

### Round-2 resolution (verified)
- **S14** [Critical, escalate:true] orchestrator early-return: RESOLVED by C2 invariant + forbidden line-order grep
- **T14** [Critical] race test → raceTwoClients + N=50: RESOLVED by C5 acceptance referencing precedent at mcp-token-rotation-race
- **T16** [Critical] CSRF gate request-attribute-based: RESOLVED (same as S14)
- F18-F26, S15-S20, T13-T21: all RESOLVED

### Round-3 new findings (7)

#### Major
- **S21**: Orchestrator early-return bypasses tenant IP access restriction (`checkAccessRestrictionWithAudit`). Session cookie may be valid but request IP outside tenant `allowedIpRanges`. Fix: add IP check inside route handler after `auth()`.

#### Minor
- **S22**: forbidden pattern needed for `credentials:"include"` outside `startConnect` (prevent future SW fetch from copying)
- **S23**: preflight + actual-response symmetry test for Allow-Credentials
- **S24**: audit deferral noted; eventual addition of `EXTENSION_BRIDGE_CODE_ISSUE_FAILURE` with Origin-miss reason code
- **T22**: race test `bothFailed === 0` may be too strict; relax to `< N` per precedent
- **T23**: C13 manual step #1 references `tokenCnfJkt` key — confirm exact schema name vs `session-storage.ts`
- **T24**: forbidden pattern path should be anchored to `src/app/api/extension/bridge-code/route.ts`

### Round-3 fixes applied

All 7 Round-3 findings have been folded into the plan v3+:
- **S21** → C2 invariant + C4 step 4.5 (`checkAccessRestrictionWithAudit`)
- **S22** → C4 forbidden pattern
- **S23** → C3 acceptance criterion (preflight + actual symmetry)
- **S24** → C14 already documents the deferral with TODO marker; Origin-miss reason as a future enhancement
- **T22** → C5 acceptance softened (`bothFailed.toBeLessThan(N)` with rationale)
- **T23** → C13 step #1 disclaims storage-key naming dependency, points at `session-storage.ts` schema
- **T24** → C4 forbidden pattern path anchored

## Convergence

- Round 1: 42 findings (3 Critical + 17 Major + 22 Minor)
- Round 2: 24 findings (2 Critical + 11 Major + 11 Minor)
- Round 3: 7 findings (0 Critical + 1 Major + 6 Minor) — all resolved

Plan v3+ is **converged**. Ready for Phase 2 (implementation).
