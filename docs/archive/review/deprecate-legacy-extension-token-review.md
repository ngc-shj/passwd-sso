# Plan Review: deprecate-legacy-extension-token

Date: 2026-05-24
Review rounds completed: 2

## Round 1 Summary

### Functionality Findings
- [F1] Critical: Web-app UI consumer `CliTokenCard` still POSTs to legacy endpoint — plan omits it. → **RESOLVED** (scope expansion, C8).
- [F2] Critical: API_ERROR contract shape mismatch (3 maps + 2 i18n JSON files required). → **RESOLVED** (C3 rewritten).
- [F3] Critical: Prisma `AuditAction` enum migration required. → **RESOLVED** (C5).
- [F4] Major: R12 walkthrough hedge-worded. → **RESOLVED** (concrete enumeration).
- [F5] Major: §3 backward-compat overstates "non-blocking". → **RESOLVED** (§3 rewritten).
- [F6] Major: Anonymous audit emission helper unspecified. → **RESOLVED** (C6: `ANONYMOUS_ACTOR_ID` + `ACTOR_TYPE.ANONYMOUS`).
- [F7-F8] Minor: OpenAPI verification + test deletion enumeration. → **RESOLVED**.

### Security Findings
- [S1] Major: Removed rate limiter on legacy POST enables audit-log DoS. → **RESOLVED** (C7: IP-keyed limiter).
- [S2] Minor: §C1 "exactly one audit row per invocation" conflicts with unauthenticated callers. → **DOCUMENTED** (§5 risk register).

### Testing Findings
- [T1] Critical: userId source for audit emission unspecified. → **RESOLVED** (C6).
- [T2] Critical: `vi.mock("@/lib/audit/audit", ...)` not added. → **RESOLVED** (C4).
- [T3] Major: POST test deletion enumeration incomplete. → **RESOLVED** (C4).
- [T4] Major: Deprecation header assertion path missing. → **RESOLVED** (C1 + C4).
- [T5-T6] Minor: stale mocks + RT3 import. → **RESOLVED**.
- [T7] Minor: proxy.test naming. → **DEFERRED** (§6 TODO).

## Round 2 Summary

### Functionality Findings (new in round 2)
- [F9 (new in round 2)] Major: Sidebar parent retention is deterministic (`api-keys`+`mcp-connections` siblings exist) — plan should state factually, not conditionally. → **RESOLVED** (matrix #14 rewritten).
- [F10 (new in round 2)] Minor: Migration slug convention mismatch (`add_<action>_audit_action` is the established pattern). → **RESOLVED** (matrix #5 corrected).

### Security Findings (new in round 2)
- [S3 (new in round 2)] Major: C7 falsely claims `checkRateLimitOrFail` emits 429 audit (it only emits on 503 redisErrored). → **RESOLVED** (C7 acceptance criteria + Scenario E rewritten).
- [S4 (new in round 2)] Minor: C7 helper composition diverges from `exchange/route.ts` convention; `rateLimitKeyFromIp` arity was wrong (1-arg, not 2-arg); IPv6 attacker bypass risk if Phase 2 follows the plan literally. → **RESOLVED** (C7 signature uses `checkIpRateLimit` + `checkRateLimitOrFail({result, ...})` two-step pattern matching exchange/route.ts).
- [S5 (new in round 2)] Minor: `subTab.cliToken` translation key in `messages/{en,ja}/Settings.json` orphaned by C8. → **RESOLVED** (matrix #14b added).

### Testing Findings (new in round 2)
- [T8 (new in round 2)] Major: C4 mock-name inventory inaccurate (used `mockExtensionToken*` style; actual file uses bare `mockCreate`/`mockFindMany`/etc.). → **RESOLVED** (C4 §Remove rewritten with verified names).
- [T9 (new in round 2)] Major: Test #3 spy assertion references unmocked `issueExtensionToken`. → **RESOLVED** (dropped test #3; forbidden-pattern grep in C1 enforces equivalently).
- [T10 (new in round 2)] Minor: C4 missing additional vi.mock blocks (ip-access, rate-limit-audit, logger); should explicitly note "don't copy `personalAuditBase` from exchange". → **RESOLVED** (4 vi.mock blocks listed in C4 §Add).
- [T11 (new in round 2)] Minor: Manual-test step 3 asserts `audit_outbox` row that won't exist per C6 dead-letter routing. → **RESOLVED** (§Testing strategy step rewritten).
- [T12 (new in round 2)] Minor: MAX_ACTIVE rotation test deleted from route.test.ts but code path still live in exchange flow; verify coverage in exchange/route.test.ts. → **DEFERRED with mandatory action** (§6 TODO — Phase 2 must port if absent).

## Adjacent Findings

None across both rounds.

## Quality Warnings

None.

## Round 2 → Plan revision summary

Round 2 surfaced 4 Major findings (S3, S4, T8, T9) all of which were docs/plan accuracy errors — none required architectural changes. The plan now correctly:
- Uses the `checkIpRateLimit` + `checkRateLimitOrFail({result, ...})` two-step pattern (S4).
- States that 429 paths are NOT audit-emitted; observability is via `pre_auth_skip` warn log (S3).
- Lists mock symbols with names verified against the actual `route.test.ts` (T8).
- Enforces "no auth/issueExtensionToken calls" via forbidden-pattern grep instead of an unmockable spy test (T9).
- Includes `subTab.cliToken` translation cleanup in C8 sweep (S5).
- States sidebar parent retention as fact, not condition (F9).
- Uses correct Prisma migration slug convention (F10).
- Manual-test artifact correctly asserts dead-letter routing for anonymous emissions (T11).
- Tracks MAX_ACTIVE coverage migration as mandatory pre-merge action (T12).

Go/No-Go Gate now has 8 contracts (C1-C8), 22 file operations total. Plan is ready for Phase 2 transition pending one more verification round if context permits, or final orchestrator sign-off.

## Recurring Issue Check (cumulative across both rounds)

### Functionality expert
- R1: pass (Round 2)
- R2: pass
- R3: pass (Round 2 — C8 sweep verified complete via grep)
- R4-R11: N/A
- R12: pass (covered by C2; exhaustiveness tests will enforce)
- R13: N/A
- R14: pass (C5 covers Prisma enum addition)
- R15: pass
- R16-R27: N/A or pass
- R28: pass (4-arg errorResponse verified)
- R29: pass (RFC 9110 + RFC 9745 verified)
- R30-R37: N/A or pass

### Security expert
- R1: pass (Round 2 — C7 fixed to use established helper composition)
- R2: pass
- R3: pass (Round 2 — S5 caught orphan translation key, now in matrix)
- R12, R14, R15: pass
- R17, R22: pass (C6 correctly rejects new helper)
- R29: pass (RFC 9745 Boolean form `"true"` verified compliant)
- R31: pass (additive enum, reversible file deletions)
- R35: pass
- R36: pass
- R37: pass (Round 2 — S3 fixed the false platform-behaviour claim)
- RS1: N/A
- RS2: pass (Round 2 — C7 IP-keyed limiter)
- RS3: N/A
- RS4: pass

### Testing expert
- R1-R28: N/A or pass
- R29: pass
- R35: pass (manual-test artifact correctly named, content fixed in Round 2)
- R36: pass
- R37: N/A
- RT1: pass (Round 2 — T2 + T8 + T10 fixed mock alignment)
- RT2: pass
- RT3: pass (Round 2 — forbidden-pattern enforces import)
- RT4: N/A
- RT5: pass
