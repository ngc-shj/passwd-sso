# Plan Review: personal-security-ia-redesign
Date: 2026-05-02
Review rounds: 4 (clean)

## Round 1 — Initial review
Critical: 2 / Major: 13 / Minor: 17. All addressed via plan rewrites of audit emission, URL redirect map, page-level vault gating, sidebar refactor scope, recipient flow verification, mobile testing infra, sunset injection, etc.

## Round 2 — Factual error verification
Critical: 2 / Major: 3 / Minor: 5. Found wrong file paths (`audit-action.ts`, `audit-action-group.ts` don't exist), false test-coverage claim (`audit-action-key.test.ts` doesn't iterate enum), wrong i18n paths (`messages/ja.json` doesn't exist; per-namespace files), wrong consumer claim (`ChangePassphraseDialog` only consumed by header). All corrected with grep-verified paths.

## Round 3 — Implementation reality check
Critical: 2 / Major: 3 / Minor: 4. Found that `audit-emit/route.ts` hardcodes `scope: TENANT` (no scope plumbing), Prisma `enum AuditAction` migration was missing, server-side idempotency requires schema work or outbox-aware check, `next.config.ts` not directly importable in Vitest, integration test in wrong directory, sunset CI freshness needed env gates. All addressed: bodySchema extension with default-TENANT for backward compat, Prisma enum migration step added, idempotency scoped to client-side localStorage dedup (with documented bound), `buildLocaleRedirects()` helper extraction, integration test moved to `src/__tests__/db-integration/`, env-gated freshness test.

## Round 4 — Internal consistency verification
Found 1 stale unit-test assertion (server-side idempotency contradicting client-side dedup decision). Single-line fix applied.

## Final state
All Critical and Major findings resolved. Minor findings either addressed in plan or documented as deferred (Cmd-K palette, sign-up recovery key, linked accounts UI, Watchtower expansion, tenant-admin spillover cleanup).

## Recurring Issue Check (consolidated across 4 rounds)

### Functionality expert
- R1 (Shared utility reimplementation): Resolved — `useVault().lock()` reused; `buildLocaleRedirects()` SSoT for prod + tests
- R2 (Constants hardcoded): Resolved — `IA_REDIRECTS` const; `BANNER_SUNSET_TS` injectable
- R3 (Pattern propagation): Resolved — dual grep `SecuritySection|security section` + extension fixtures
- R4 (Event dispatch gaps): Resolved — recipient-flow verification step
- R7 (E2E selector breakage): Resolved — extension test fixture updates
- R11 (Display group ≠ subscription group): Resolved — new `AUDIT_ACTION_GROUP.SETTINGS`
- R12 (Enum/action group coverage): Resolved — explicit registration in 7 sites
- R13 (Re-entrant dispatch loop): Resolved — `PASSKEY_EXEMPT_PREFIXES` narrow exact-match
- R14-R16: N/A
- R17, R18: Resolved — passkey exempt prefix narrow scope
- R19 (Test mock alignment): Resolved — VAULT_STATUS const, not literals
- R21 (Subagent verification): N/A this phase
- R23 (Mid-stroke input): N/A
- R24 (Migration additive+strict): N/A — single non-destructive enum addition
- R25 (Persist/hydrate symmetry): Resolved — banner sunset cleanup tracked
- R26-R30: N/A or no issue
- R31 (Destructive ops): N/A
- R32 (Boot smoke test): N/A — no new long-running artifact
- R33 (CI config drift): Documented — i18n CI gate via existing `messages-consistency.test.ts` + new code-grep test
- R34 (Adjacent pre-existing bugs): Resolved — `PASSKEY_EXEMPT_PREFIXES` and existing audit-emit hardcode addressed within scope
- R35 (Manual test plan + Tier-1): Resolved — `personal-security-ia-redesign-manual-test.md` committed with rollback specifics

### Security expert
- R1, R3, R12, R34: linked above
- R35: Adequate
- RS1 (Timing-safe comparison): N/A — no credential comparison
- RS2 (Rate limiter on new routes): Satisfied via reuse of `/api/internal/audit-emit` existing 20/min limiter
- RS3 (Input validation at boundaries): Resolved — per-action `metadata` rejection + scope whitelist

### Testing expert
- R32 (testability gaps): Resolved — mobile Playwright projects (iPhone 13 + Pixel 7), `BANNER_SUNSET_TS` injectable, Playwright `page.clock.install()`
- R34 (trust): Resolved — parameterized E2E over `IA_REDIRECTS × routing.locales`
- R35 (rollback): Resolved — manual test rollback section enumerates residual state and enum-persistence constraint
- RT1 (Mock-reality divergence): Resolved — VAULT_STATUS const usage mandated
- RT2 (Testability verification): Resolved — Playwright 1.58 confirmed, Vitest `node` env for git-based CI test
- RT3 (Shared constants in tests): Resolved — `buildLocaleRedirects()` shared by prod and tests; explicit non-tautology

## Final findings ledger

| Round | Critical | Major | Minor | Status |
|---|---|---|---|---|
| 1 | 2 | 13 | 17 | All resolved |
| 2 | 2 | 3 | 5 | All resolved |
| 3 | 2 | 3 | 4 | All resolved |
| 4 | 0 | 0 | 1 | Resolved (single-line fix) |
| **Total** | **6** | **19** | **27** | **All resolved** |

## Quality Warnings
None — all findings included Evidence and concrete Fix.

## Anti-Deferral Audit
No findings deferred for this PR's scope. Out-of-scope items (Cmd-K palette, sign-up recovery key generation, linked accounts UI, Watchtower expansion, tenant-admin spillover cleanup) are documented as separate plans with explicit follow-up tracking, NOT as deferrals of in-scope work.
