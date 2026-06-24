# Code Review: team-config-stepup-bearer-scope
Date: 2026-06-25
Review rounds: 1 (incremental on the Phase 2 self-R-check baseline)

## Changes from Previous Round
Initial code review. Phase 2 self-R-check was clean; this round is incremental verification by 3 experts (full-diff, Ollama seeds unavailable).

## Functionality Findings
- **F1 (Minor, fixed)**: C5 members-PUT reject test asserted the two mutation spies not-called but not `mockPrismaTeamMember.findUnique` — adding the not-called assertion pins that step-up fires BEFORE the existence lookup (regression guard against a future reorder). Fixed.
- **F4/F5 (verified clean)**: `isBearerBypassRoute` OR-integration correct; other bypass routes unaffected by the `API_PATH.TEAMS` removal. C4 matcher verified against 13+ edge cases incl. `passwordsX` suffix and `//` double-slash.
- **F3 (Minor, skipped — documented)**: in-code `TODO(team-config-stepup)` markers for the SC1-deferred routes (rotate-key, team-DELETE, member-DELETE) were proposed. Skipped: the deferral is the system-of-record in the plan's SC1 + deviation log; adding comments to 3 otherwise-untouched route files expands the diff with noise for no behavior change (YAGNI). See deviation D2.

## Security Findings
- **C4 path-traversal (verified clean)**: `nextUrl.pathname` is normalized by the WHATWG URL parser before the matcher — `..`, `%2e%2e`, `%2F`-in-segment all resolved/safe; the `passwords(/.*)?` arm cannot be reached via `passwords/../webhooks` (normalizes to `/api/teams/t1/webhooks` → deny). ReDoS measured safe (~25ms/1000 pathological iters).
- **C4 least-privilege (verified)**: the new allow-set (teams + member-key + passwords/**) is a strict SUBSET of the old broad `/api/teams/**` prefix — only allow→deny moves, never deny→allow. All real iOS/extension Bearer paths remain allowed.
- **S1 constraint (verified clean — no live hole)**: systematic grep of all `teams/*/passwords` child handlers confirms every one uses `auth()` (session-only); NONE use `checkAuth` with a write scope. The passwords-prefix Bearer-reachability is safe today; the locked-constraint comment guards the future.
- **C1-C3,C5 (verified)**: authz before step-up in all 4; step-up dominates all mutation branches (incl. members-PUT OWNER-transfer `$transaction` + regular `update`). C1 webhook-create 201 keeps `NO_STORE_HEADERS`.
- **R34 (verified complete)**: full tenant→team gated-route mapping confirms C1-C5 cover every gated tenant route with a team analog; the rest have no team analog. No gap.
- **C2 webhook-DELETE existence-before-step-up oracle (Informational, accepted)**: a non-recent TEAM_UPDATE admin can distinguish webhook-exists (403) vs not (404). Identical to the tenant pattern from PR #606; accepted as consistent baseline.

## Testing Findings
- **T1 (Minor, fixed)**: added a `/api/teams/t1/passwordsX → deny` row to cors-gate.test.ts (suffix-collision guard, mirroring the existing top-level `/api/passwordsx` row). Fixed.
- **T2 (Minor, skipped — accepted)**: the centralized team-policy.test.ts has the pass-through mock but no step-up reject test (the co-located policy route.test.ts has it). The plan scoped the centralized file to pass-through-only by design; duplicating the reject test is churn. Co-located coverage is sufficient.
- **RT1/RT2 + R19 (verified)**: all 4 reject tests non-vacuous (drive past authz; DELETE pre-sets findFirst→row; members asserts both spies). The exhaustive `src/__tests__/` grep confirms only team-policy.test.ts imports a gated handler — the PR #606 R19 recurrence class is closed. No `resetAllMocks` (pass-through default survives `clearAllMocks`).

## Recurring Issue Check
- **R3**: clean (no propagation gaps; `API_PATH.TEAMS` correctly retained in route-policy.ts SESSION_REQUIRED_PREFIXES — different list, web auth preserved).
- **R19**: closed — centralized team-policy.test.ts mocked; exhaustive grep confirms no other centralized test imports a gated handler.
- **R34**: complete tenant→team mapping; no missed counterpart.

## Environment Verification Report
- **VC1** (Bearer-bypass narrowing): `verified-local` — the matcher is a pure function fully covered by cors-gate.test.ts (12 team rows now) + proxy.test.ts (positive bypass + deny). Live iOS/extension-against-proxy E2E stays `blocked-deferred` per the Phase-1 VC1 entry (needs running app + provisioned token), justified there; the unit matrix pins every real client path incl. the extension's `passwords/<entryId>`.

## Resolution Status
All findings Minor; F1 + T1 fixed, F3 + T2 skipped with documented justification, C2 oracle accepted as baseline-consistent. No Critical/Major. The Round-1 fixes are test-only additions confined to prior scope (no production change) → no Round 2 required (tightening-only). Final: full suite 11699 pass, tsc clean, pre-pr 38/38.
