# Code Review: personal-security-ia-redesign
Date: 2026-05-02
Review round: 1

## Changes from Previous Round
Initial review (Phase 3, post-implementation).

## Summary
- Major: 5 (F-1/T2, F-2/S2, F-3, T1, T3) — all resolved in this round
- Minor: 7 (F-4, F-5, F-6, S1, S3, T4, T5, T6) — F-4, F-5, F-6, S1, T6 fixed; S3 deferred (pre-existing, see Anti-Deferral note); T4, T5 noted but not blocking
- Informational/confirmed-correct: S4–S10 (verifications, no action)

## Functionality Findings (deduplicated)

### [F-1/T2] Major — Resolved
`route.test.ts` was missing unit coverage for the new `SETTINGS_IA_MIGRATION_V1_SEEN` action's per-action scope whitelist + metadata rejection, and for the backward-compat default scope on `PASSKEY_ENFORCEMENT_BLOCKED`. Coverage was only present in the real-DB integration test, leaving the lightweight CI gate uncovered.

### [F-2/S2] Major — Resolved
`migration-banner.tsx` set `localStorage[BANNER_DISMISS_KEY]` BEFORE firing the audit-emit fetch. Any transient failure silently marked the banner permanently dismissed AND lost the audit row — contradicting the plan's "retry-on-next-session" contract.

### [F-3] Major — Resolved
`use-sidebar-navigation-state.test.ts` test fixtures still used pre-refactor paths `/dashboard/settings/security/{...}` even though the source paths moved.

### [F-4] Minor — Resolved
`LockVaultButton` was placed AFTER `NotificationBell` in the header; plan specified BEFORE. Reordered to `Theme → LanguageSwitcher → LockVaultButton → NotificationBell → avatar` per the plan's keyboard tab-order spec.

### [F-5] Minor — Resolved
Banner's audit-emit failure handler used `console.warn` only, contradicting the plan's "toast on retry-eligible 4xx/5xx, silent retry-on-next-session for transient failure" contract. Now distinguishes `res.ok=false` (toast.error) from `fetch reject` (silent + warn).

### [F-6] Minor — Resolved
`Migration.json` (ja) modal copy used `「共有と委任」` while the actual sidebar label uses `共有・委任`. Aligned to `「共有・委任」`.

## Security Findings (deduplicated)

### [S1] Minor — Resolved
`PASSKEY_EXEMPT_PREFIXES` used `startsWith` against `["/dashboard/settings/auth/passkey"]`, allowing a hypothetical `/dashboard/settings/auth/passkey-recovery` sibling to silently inherit the bypass. Switched to exact-match Set (`PASSKEY_EXEMPT_PATHS.has(...)`).

### [S2] Same as F-2 — Resolved
(See F-2.)

### [S3] Minor — Deferred (Anti-Deferral check below)
`/api/internal/audit-emit` is classified as `API_DEFAULT` instead of `API_SESSION_REQUIRED`, so the proxy applies CORS/cache headers but does NOT validate session at the proxy layer (route handler does via `checkAuth`). CSRF gate still fires correctly.

**Anti-Deferral check**: pre-existing in unchanged file (`src/lib/proxy/route-policy.ts`). Routing target: orchestrator → out of scope for this PR. The existing endpoint has been live with `API_DEFAULT` classification since `PASSKEY_ENFORCEMENT_BLOCKED` was added; this PR did not change the classification. Tracked as a separate follow-up: `TODO(audit-emit-session-required): consider promoting /api/internal/audit-emit to API_SESSION_REQUIRED for IP-restriction parity`.

### [S4–S10] Informational — confirmed correct
- S4: scope/metadata gates verified; backward-compat for PASSKEY_ENFORCEMENT_BLOCKED preserved.
- S5: no open-redirect surface in `IA_REDIRECTS` (paths are hardcoded `as const`, unit-test enforced).
- S6: `MigrationBanner` body minimization — no metadata, scope=PERSONAL only.
- S7: `aria-label="Security"` landmark only renders inside authenticated dashboard layout (no pre-auth disclosure).
- S8: `LockVaultButton` correctly gated on `VAULT_STATUS.UNLOCKED`.
- S9: vault-sensitive pages (passphrase, recovery-key) gate the action button on `vaultUnlocked`.
- S10: `locales.ts` extraction has no security implications.

## Testing Findings (deduplicated)

### [T1] Major — Resolved
`lock-vault-button.test.tsx` race-defense test was a false-green — it rendered with LOCKED throughout, never invoking the click handler. Removed the redundant in-handler check (closure semantics make it dead code; the render-time `if (status !== UNLOCKED) return null` is the sole gate). Updated test to verify the rerender → button-removal flow.

### [T2] Same as F-1 — Resolved
(See F-1.)

### [T3] Major — Resolved
`migration-banner.tsx` and its test both used inline string `"SETTINGS_IA_MIGRATION_V1_SEEN"` instead of `AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN`. RT3 violation — a rename in `audit.ts` would not be caught at test time. Both updated to import the constant.

### [T4] Minor — Noted (not fixed)
E2E redirect spec asserts only `toHaveURL(...)`, not page content / response status. A typo'd destination in `IA_REDIRECTS` would still pass. Not blocking — the unit test (`ia-redirects.test.ts`) checks the constant structure, and the E2E covers that the 308 fires.

### [T5] Minor — Noted (not fixed)
`migration-banner-config.test.ts` skip-condition includes only `pull_request` events. `push` to main after merge is also skipped. Documented as intentional — the PR-time check is sufficient because the constant lands via PR merge.

### [T6] Minor — Resolved
`use-sidebar-sections-state.test.ts:109` test description said "insights section" while asserting the storage key `next.security`. Added a comment clarifying that the storage key intentionally retained the historical name `security` for backward compatibility with users' existing collapsed/open preferences across the rename.

## Adjacent Findings (routed)
- F-1 → routed to Testing as T2 (resolved together).
- T3 → also a Functionality concern (RT3 in production code) — resolved with shared fix.
- migration-banner failure-path coverage: was an [Adjacent] from Functionality scope, addressed in T3 + the new test in `migration-banner.test.tsx`.

## Quality Warnings
None — all findings included Evidence and concrete Fix.

## Recurring Issue Check

### Functionality expert
- R1 (string literals vs const): Checked — `lock-vault-button.tsx` and `migration-banner.tsx` now use `AUDIT_ACTION` const, not string
- R3 (incomplete propagation): F-3 (sidebar nav test fixtures), resolved
- R7 (E2E selector breakage): Checked — `e2e/page-objects/settings.page.ts` updated, no orphan selectors
- R12 (enum coverage): Checked — `SETTINGS_IA_MIGRATION_V1_SEEN` registered in all 7 sites
- R17 (helper adoption): Checked — `buildLocaleRedirects()` reused in `next.config.ts` + tests
- R34 (adjacent pre-existing bugs): S3 deferred with Anti-Deferral check
- R35 (manual test plan): Present at `docs/archive/review/personal-security-ia-redesign-manual-test.md`

### Security expert
- R3, R12, R34, R35: linked above
- RS1 (timing-safe comparison): N/A — no credential comparison
- RS2 (rate limiter on new routes): Checked — existing 20/min limiter unchanged
- RS3 (input validation at boundaries): Checked — Zod + per-action constraints

### Testing expert
- RT1 (mock-reality divergence): Checked — VAULT_STATUS imports verified
- RT2 (testability verification): Checked — Playwright 1.58 supports devices + page.clock.install
- RT3 (shared constants in tests): T3 resolved
- R7 (E2E breakage): Checked
- R32 (testability gaps): T1, T2 resolved

## Resolution Status

### [F-1/T2] Major: route.test.ts missing new action coverage
- Action: Added 5 new test cases (PERSONAL emission OK, TENANT scope rejected, metadata rejected, PASSKEY_ENFORCEMENT_BLOCKED defaults to TENANT, PASSKEY_ENFORCEMENT_BLOCKED accepts explicit PERSONAL).
- Modified file: `src/app/api/internal/audit-emit/route.test.ts`

### [F-2/S2] Major: localStorage write before fetch
- Action: Inverted order — `setDismissed(true)` for optimistic UI, then `await fetchApi(...)`, then `localStorage.setItem` only when `res.ok`. Added `toast.error` for `res.ok=false`.
- Modified file: `src/components/settings/migration-banner.tsx`; `messages/{ja,en}/Migration.json` (added `dismissError` key)

### [F-3] Major: stale path fixtures in sidebar nav test
- Action: Updated test descriptions and fixture paths to new IA paths (`/dashboard/settings/auth/passkey`, `/dashboard/settings/account`).
- Modified file: `src/hooks/sidebar/use-sidebar-navigation-state.test.ts:153–179`

### [F-4] Minor: LockVaultButton tab order
- Action: Reordered header to `LockVaultButton` before `NotificationBell`.
- Modified file: `src/components/layout/header.tsx:107–108`

### [F-5] Minor: silent failure on audit-emit
- Action: Distinguish `res.ok=false` (toast.error) vs `fetch reject` (silent + warn). New i18n key `Migration.banner.dismissError`.
- Modified file: `src/components/settings/migration-banner.tsx`; `messages/{ja,en}/Migration.json`

### [F-6] Minor: ja modal copy mismatch
- Action: `「共有と委任」` → `「共有・委任」` in modal item copy.
- Modified file: `messages/ja/Migration.json`

### [S1] Minor: PASSKEY_EXEMPT prefix-match too broad
- Action: Switched from `Array<string>.startsWith` to `ReadonlySet<string>.has` (exact match).
- Modified file: `src/lib/proxy/page-route.ts:23–35`

### [S3] Minor: audit-emit not API_SESSION_REQUIRED — Deferred
- **Anti-Deferral check**: pre-existing in unchanged file
- **Justification**: out of scope (different feature) — the route classification has been `API_DEFAULT` since the endpoint's introduction. Tracked as `TODO(audit-emit-session-required)` for separate work.
- **Orchestrator sign-off**: out-of-scope routing accepted; not introduced by this PR.

### [T1] Major: race defense test false-green
- Action: Removed redundant in-handler check (dead code given closure semantics). Updated test to verify the render-time gate via rerender → button-removal flow.
- Modified file: `src/components/layout/lock-vault-button.tsx:14–22`; `src/components/layout/lock-vault-button.test.tsx:103–117`

### [T3] Major: inline string instead of AUDIT_ACTION const
- Action: `MigrationBanner` and its test now import `AUDIT_ACTION`/`AUDIT_SCOPE` from `@/lib/constants`.
- Modified file: `src/components/settings/migration-banner.tsx:14`; `src/components/settings/migration-banner.test.tsx:6`

### [T4] Minor: E2E asserts only URL, not content — Noted
- Reason: low-impact; unit test catches typos, E2E covers redirect mechanics. Spot-check destination content is a defensible follow-up but not blocking.

### [T5] Minor: sunset CI freshness only on PR — Noted
- Reason: intentional — sunset constant lands via PR merge, so the PR-time check covers all production code paths. Post-merge skip is by design.

### [T6] Minor: test description / storage key mismatch
- Action: Added comment explaining the storage key `security` was preserved for backward compat with user-saved sidebar state across the SecuritySection → InsightsSection rename.
- Modified file: `src/hooks/sidebar/use-sidebar-sections-state.test.ts:109–122`

## Seed Finding Disposition (consolidated)
Seed unavailable — no dispositions to record (Ollama pre-screening was skipped in this run due to large diff size).

## Verification Gate Run

| Gate | Result |
|---|---|
| `npm run lint` | ✅ Clean |
| `npx vitest run` | ✅ 7836 / 7838 passed (2 skipped — CI-only freshness check) |
| `npx next build` | ✅ Production build succeeded |

## Round 2 — Verification

R2 verification (consolidated functionality / security / testing) confirmed:
- All 11 R1 fixes verified resolved with correct, complete implementations.
- S3 Anti-Deferral check format confirmed in this document.
- No new findings introduced by R1 fixes.
- Cross-cutting checks (i18n parity, mock isolation, header position) clean.

**Final state**: all in-scope findings resolved. S3 deferred with proper Anti-Deferral routing.
