# Plan Review: admin-token-redesign

Date: 2026-04-27

## Round 3 (convergence)

### Changes from Previous Round

Round 2 produced 1 Critical (auth-time formula), 7 Major (PERSONAL group, migration split, cache contradiction, cache reset hook, mock-surface, chain-verify integration only), 11 Minor. All applied to the plan.

### Findings

**Functionality**: 0 Critical, 0 Major. 3 Minor (F21 HMR note added; F22 audit-table spot-check no issue; F23 deprecation header responsibility split clarified).

**Security**: **No new findings.** All Round 2 issues verified resolved. Plan is at security-convergence.

**Testing**: 1 Major (T21 — Round 2 mock-surface enumeration was factually wrong: `audit-outbox-metrics` and `audit-outbox-purge-failed` use `prisma.$queryRaw`, not `aggregate`/`deleteMany`; `dcr-cleanup` uses only `mcpClient.deleteMany`, not three separate models). 1 Minor (T22 — `MockModel` helper doesn't type `$queryRaw`; canonical bypass pattern is `audit-outbox.test.ts:20,67`).

### Resolutions applied in Round 3 fixes

- **T21** Major → §7 per-route mock surfaces rewritten with verified-correct primitives; canonical `$queryRaw` mock reference cited.
- **T22** Minor → MockModel gap noted; bypass pattern documented; no helper rewrite required for v1.
- **F21** Minor → §4.6b adds dev-mode HMR note.
- **F23** Minor → §6 step 4 clarifies route-handler responsibility for `Deprecation`/`Sunset` headers; recommends shared `applyDeprecationHeaders` helper.

### Convergence assessment

After Round 3 fixes:
- Functionality: zero outstanding Critical/Major.
- Security: zero outstanding Critical/Major. Plan at convergence.
- Testing: zero outstanding Critical/Major. T21 root cause (factually-wrong mock surfaces) corrected.

The plan is **converged after 3 rounds**. No further review rounds expected to surface Critical or Major issues. Phase 2 implementation can proceed against this plan.

## Round 2

### Changes from Previous Round

Round 1 produced 3 Critical, ~17 Major, ~9 Minor findings; all were addressed in plan edits across §4.3, §4.6, §4.6a, §4.6b, §4.7, §4.8, §5.1, §5.2, §6 steps 1–10, §7, §8, §10. Round 2 verified resolutions and surfaced 1 new Critical (auth-time formula), 7 Major (PERSONAL group, migration split, cache contradiction, cache reset hook, mock-surface, chain-verify integration only), 11 Minor.

### Critical (Round 2 → resolved in Round 2 fixes)

- **F15/S14/T13** Step-up "auth time" formula `Session.expires - Session.maxAge` was wrong — `expires` is rolling, the formula yields drift not auth time. **Fix applied**: §6 step 5 now uses `Session.createdAt` via direct Prisma lookup; documented accepted-risk that this means "session-creation time" bounded by absolute timeout.

### Major (Round 2 → resolved in Round 2 fixes)

- **F16** `AUDIT_ACTION_GROUPS_PERSONAL[ADMIN]` does not exist in the codebase — Round 1 fix incorrectly added it. **Fix applied**: §4.7 + §6 step 2 + §8 R12 now register the new actions in `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` only (matches `MASTER_KEY_ROTATION` precedent).
- **F17** Migration split into two files was unnecessary; this repo's Postgres 16 + Prisma 7 support `ALTER TYPE ADD VALUE` in transactions (verified against existing repo migrations). **Fix applied**: §5.2 collapsed to single migration file with `IF NOT EXISTS` guard.
- **S13/F18-A** §4.6b cache spec contradicted §6 step 3 — TTL re-check on `true` reintroduces the legacy-re-enable race. **Fix applied**: monotonic latch design (`everSeenActiveToken: boolean`, no TTL on `true`, only resets on process restart). §7 cache test rewritten to assert monotonicity.
- **T14** Cache reset test hook missing — `_resetActiveOperatorTokenCacheForTests()` added per `_resetSubkeyCacheForTests()` precedent.
- **T15** 4 new route tests need per-route mock-surface enumeration — added in §7 (dcr-cleanup mocks `mcpAccessToken/mcpRefreshToken/mcpClient`; audit-outbox-metrics mocks `auditOutbox.aggregate`; audit-outbox-purge-failed mocks `auditOutbox.deleteMany`; audit-chain-verify is integration-test-only).
- **T19** `audit-chain-verify` audit-emit assertion is hollow under mocks — moved to integration test only (chain-walk requires real DB ordering).

### Minor (Round 2 → resolved)

- **F19** Audit table now explicitly notes legacy keeps `metadata.operatorId`, operator path uses `metadata.tokenSubjectUserId`.
- **F20** §6 step 1 prisma generate rephrased as "if your editor LSP didn't pick up the new client" (Prisma 7 db:migrate runs generate as post-step).
- **S15** Sunset constant regression test added in §7 (format check + future check + ≥6mo lower bound).
- **S16** Phase B self-lockout warning added to §10 documentation step.
- **S17** Revoke route now mandates `withTenantRls(...)` + tenantId match check (404 on mismatch) per SCIM-tokens precedent.
- **S18** `lastUsedAt` cross-operator disclosure documented as accepted in §8 (matches SCIM-tokens UI).
- **T16** NextRequest construction reference added (canonical: existing `*-endpoint.integration.test.ts`).
- **T20** Legacy-path tests now mandate `expect.toBeUndefined()` on `tokenId`/`tokenSubjectUserId`.

## Round 1

### Changes from Previous Round

Initial review.

### Summary by severity

- **Critical (2)**: T1 (4 of 7 route test files don't exist), T2 (integration "fetch against running app" harness doesn't exist).
- **Major (~17)**: F1 schema `@db.Uuid`, F2/T3/T11 i18n path, F3 PERSONAL audit group (later corrected by Round 2 F16), F4 Postgres ALTER TYPE tx (later corrected by Round 2 F17), F5 prisma generate ordering, F6 legacy audit metadata, F7 metadata.operatorId trust shadowing, F9 per-route audit-emit table, F10 OpenAPI decision, F14 env-schema/allowlist gap, S1 Phase A blast radius, S2 issuance step-up, S4 sunset discipline, S9 createdByUserId enforcement, T4 verifyAdminToken async ripple, T5 scope CSV vs scopes array, T6 token plaintext test util, T7 throttle test clock control, T8 demoted-subject test placement.
- **Minor (~9)**: F8 throttle constant, S3 plain SHA-256 accepted-risk note, S5 restart caveat, S6 TOCTOU observability sentence, S10 dcr-cleanup script as separate PR, T9 OpenAPI snapshot, T10 CI smoke vague, RS2 revoke rate suggestion.
- **Adjacent (5)**: F11-A prefix entropy, F12-A Phase A risk routing, F13-A demote→401 layer, S11-A test asymmetry, S12-A tenantId arg plumbing.

(Detailed Round 1 findings and resolutions: see git history of this file at the v1 plan-creation commit, or earlier draft `/tmp/tri-oXm62r/round1-merged.txt` if preserved.)

## Quality Warnings

No findings flagged `[VAGUE]`, `[NO-EVIDENCE]`, or `[UNTESTED-CLAIM]` in either round.

## Recurring Issue Check (final state after Round 2)

### Functionality expert
- R1: OK
- R2: OK (F8 fixed)
- R3: OK (F9 table added)
- R4: OK (TENANT_WEBHOOK_EVENT_GROUPS[ADMIN] inheritance verified)
- R5: OK (TOCTOU §8 quantified)
- R6: OK
- R7: N/A
- R8: OK
- R9: OK (lastUsedAt outside tx)
- R10: OK
- R11: OK (TENANT[ADMIN] only — Round 2 F16)
- R12: OK (Round 2 F16 corrected group; Round 1 F2 corrected i18n path)
- R13: OK
- R14: OK
- R15: OK
- R16: OK
- R17: OK (route table + sweep)
- R18: OK (no env var)
- R19: OK (Round 2 T20 strict-shape on legacy)
- R20: N/A
- R21: N/A Phase 1
- R22: OK
- R23: N/A
- R24: OK (single migration — Round 2 F17)
- R25: OK
- R26: OK (UI greys revoked rows)
- R27: OK
- R28: N/A
- R29: OK (no spec citations)
- R30: OK (#NNN intentional)

### Security expert
- R1-R30: OK or covered
- RS1: OK (timing-safe maintained)
- RS2: OK (revoke 30/min)
- RS3: OK (Zod .strict())

### Testing expert
- R1-R30: OK or covered
- RT1: OK (chain-verify integration-only — Round 2 T19)
- RT2: OK (auth-time via createdAt — Round 2 T13 resolved)
- RT3: OK (constants imported)

## Status

All Critical and Major findings from both rounds resolved in the plan. Round 3 will verify or surface residual issues; the orchestrator's expectation is convergence.
