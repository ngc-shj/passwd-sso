# Phase 3 Code Review: extension-dpop-sender-constrained

Date: 2026-05-25
Phase: 3 (code review on implemented branch — Round 1)

## Context

Phase 1 locked 14 contracts (C1-C12, C3b, C9a). Phase 2 implemented across 71 files (4593 insertions / 241 deletions) and verified: lint 0 errors, vitest pass, next build pass, pre-pr.sh 29/29 pass. Phase 3 launched 3 expert sub-agents (functionality / security / testing) in parallel.

## Findings Summary

| ID | Severity | Source | Subject |
|---|---|---|---|
| S1 / F1 | Major | Sec + Func (duplicate) | `handleResetConnection` doesn't delete IDB key — `resetInMemoryKeyCache()` only clears Promise singleton; FR12 violation |
| A1 | Major (Adjacent) | Func | `token-handler.ts` extraction unused by production `index.ts` — two diverging implementations |
| T1 | Major | Test | `extension/src/__tests__/background/swFetch-dpop.test.ts` missing — C8 contract untested |
| T2 | Major | Test | JKT_REQUEST/JKT_READY roundtrip untested in token-bridge.test.ts |
| F2 | Major | Func | DPoP header conditionally attached without early-exit on null proof (silent server 401) |
| F3 | Major | Func | `validateIosTokenDpop` retains inline implementation instead of re-export (duplication risk) |
| T3 | Moderate | Test | token-bridge.test.ts doesn't assert DPoP header on fetch call (RT5) |
| T4 | Moderate | Test | mid-keygen kill test is dead code — `patchedOpen` never assigned to `indexedDB.open` |
| T5 | Moderate | Test | Missing tokenCnfJkt-absent upgrade-scenario test |
| S2 | Minor | Sec | Non-standard `cnf:{jkt}` claim in DPoP proof payload (RFC 9449 §4.2 deviation, harmless) |
| T6 | Minor | Test | jtiCache mock shape `{has, add}` vs real `{hasOrRecord}` (RT1) |
| T7 | Minor | Test | `setTimeout(10ms)` anti-pattern in validate-token-dpop.test.ts |
| T8 | Minor | Test | E2E test description claims follow-up API call but only tests exchange |
| T9 | Minor | Test | Migration test can't directly verify DELETE step (structural limitation) |
| F1-info | Info | Func | Stale TODO in dpop-key.ts about Batch 1 + `cnfJkt?` optional cast in index.ts:501 |

## Severity disposition
- **Critical**: 0
- **Major**: 6 (S1/F1, A1, T1, T2, F2, F3) — all addressed in fix-up round
- **Moderate**: 3 (T3, T4, T5) — addressed in fix-up round
- **Minor**: 5 (S2, T6, T7-T9, F1-info) — S2 + T6 + stale TODO addressed; T7-T9 deferred

## Verified clean (no findings — confirmation only)
- C1 migration SQL: 4-step ordering correct (TRUNCATE → DELETE → ADD COLUMN → CHECK), single-transaction
- C2 cnfJkt required + step-up preserved + Zod strict
- C3 always-DPoP + no `if (consumed.cnfJkt)` + no `expectedAth:` in exchange
- C3b response shape includes cnfJkt
- C5 forbidden-pattern grep: no `if (token.cnfJkt)` in validateExtensionToken's BROWSER_EXTENSION branch
- C6 non-extractable key + persist-before-resolve ordering
- C8 grep: zero `Authorization.*Bearer.*currentToken` in index.ts outside swFetchAuthenticated
- C9a `"use client"` directive + reqId + origin/source filter + finally cleanup
- C10 refresh-create payload includes cnfJkt (`data.cnfJkt = validated.cnfJkt`)
- C11 CORS Allow-Headers: `Content-Type, Authorization, DPoP`
- C12 body-cnfJkt-must-match-proof BEFORE updateMany; userId in WHERE clause; per-user rate limit; safeStringEqual (timing-safe)
- canonicalHtuClient basePath handling correct
- migration CHECK constraint allows IOS_APP null, rejects BROWSER_EXTENSION null
- No bearer token logged anywhere

## i18n + pre-1.0 wording
- New `extensionRequired` / `extensionRequiredAction` strings use "requires latest version / 最新版が必要です" — pre-1.0 compliant. No "廃止/deprecated/利用できません" wording.

## Recurring Issue Check (Phase 3 cross-section)
- R1-R37: covered by per-expert checks; no rule failed across all 3 experts.
- RS1-RS4 (Security): all pass (S2 is a spec compliance nit, not a security regression).
- RT1-RT5 (Testing): RT5 partial — DPoP-header-on-the-wire assertion missing (T3); race-test for mid-keygen kill is dead code (T4).
