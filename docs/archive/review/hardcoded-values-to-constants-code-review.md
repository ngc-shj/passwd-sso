# Code Review: hardcoded-values-to-constants
Date: 2026-06-14
Review rounds: 3 (converged)

## Changes from Previous Round
- Round 1: reviewed committed C1–C13 + initial C14 work. All findings Minor; resolved.
- Round 2: reviewed the C14 exhaustive time-literal normalization + extension/cli/prisma residual fixes + Round-1 Minor fixes. One Major (F8) + several Minor.
- Round 3: verified all Round-2 fixes. No findings. Loop terminated.

## Functionality Findings

### Round 1 (all resolved)
- F1 Minor — `crypto-client.ts` non-null assertion `ARGON2ID_KDF_PARAMS.kdfMemory!` → replaced with type-safe `?? 65536` fallback chain. Value-identical.
- F2 Minor — i18n test stale comment ("when C1 creates…") → updated to D4-aware wording.

### Round 2
- F6 Minor — `format-datetime.ts` import inserted mid-file (ESLint import/first) → moved to top. **Resolved.**
- F7 Minor — `audit.ts` duplicate `MS_PER_MINUTE` import (line 2 + line 818) → merged. **Resolved.**
- **F8 Major** — `audit-outbox-worker.ts checkDepthAlert()` read `OUTBOX_READY_OLDEST_THRESHOLD_SECS` / `OUTBOX_READY_PENDING_THRESHOLD` directly with stale defaults (3600s / 1000) that diverged from the canonical `AUDIT_OUTBOX` defaults (600s / 10_000) declared in both `audit.ts` and `env-schema.ts`. Pre-existing inconsistency surfaced by C14 normalizing the `AUDIT_OUTBOX` definition. Fix: worker now consumes `AUDIT_OUTBOX.READY_OLDEST_THRESHOLD` / `READY_PENDING_THRESHOLD`. **Deliberate behavior change** when env vars unset: alert thresholds move to the documented canonical values (the old worker defaults were the divergent, undocumented ones). Round 3 confirmed unit-correct (seconds vs seconds), single-source, no other stale consumer. **Resolved.**
- F9 Minor — `env-schema.ts` audit-outbox + DB-pool blocks had partially-normalized time bounds → completed (byte-identical; `.min(100)`/`.min(30)`/counts/hours/days left as no clean base). **Resolved.**

Value-identity spot-checks (Round 2): 15+ replacements across prisma.ts, common.ts (JIT/DELEGATION TTL → SEC_PER_*), common.server.ts, audit.ts, extension, cli — all numerically identical. Classification correct (pool `max:200` connection count untouched). Unit correct (seconds → SEC_PER_*, ms → MS_PER_*).

## Security Findings
- Round 2: S5–S17 all "No issue" — every security-relevant TTL/timeout (JIT/DELEGATION token lifetime, DPoP JTI replay window, iat epoch-seconds, rate-limit window, session/policy caches, mobile-token grace) verified byte-identical; no 1000× unit error; AAD/HKDF/token-prefix/storage-key strings untouched.
- S11 Minor — extension-constants-sync test's `extractNumericConst` regex widened for MS_PER_* identifiers; the post-substitution `/^[0-9_*\s]+$/` guard keeps `Function()` safe (rejects any un-whitelisted identifier → loud failure, no RCE widening). Added whitelist comment + a guard test. **Resolved.**
- Round 3: no new security findings.

## Testing Findings
- Round 1: T1/S2 PrivacyPolicy assertion fragile-locale → derives via `Intl.NumberFormat(locale).format(PBKDF2_ITERATIONS)`; T2 recovery-key-banner duplicate key → single-sourced from mock; T3 NOTIFICATION_BELL_LIMIT coverage gap → positive-integer test added to common.test.ts; T4 refresh-route mock missing EXTENSION_TOKEN_REVOKE_REASON → added with exact real values. All resolved.
- Round 2: T5 Minor — recovery-key-banner.test bare `60_000` → `MS_PER_MINUTE`. **Resolved.** All new/changed tests confirmed non-vacuous (sync drift detection, ICU format match, mock-reality alignment).
- Round 3: no new testing findings.

## Adjacent Findings
None outstanding.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R2: checked-clean (the entire change IS the R2 remediation; inventory verified exhaustive via repeated `rg` audits). R3: F8 propagation closed (no stale env-var consumer remains). R17/R19: helper/mock adoption complete. R22 (perspective inversion): the user-driven `rg 1000`/`rg _000` audits + Round-2 F8/F9 caught the syntactically-different equivalents the frequency-ranked Phase-1 inventory missed. R25: storage keys value-identical. R27: i18n interpolation from canonical constants. R37: const-object convention followed; no value drift.

### Security expert
- R2/R3 clean (no secrets; F8 propagation closed). R25 N/A. R27: TTL display==enforcement (same constants). R30: token prefixes value-identical. R31: no destructive ops. R37 (AAD distributed contract): ZERO HKDF/AAD/setAAD/additionalData changes across the whole diff — confirmed by grep. RS1: all time-constant substitutions are arithmetic identities; no 1000× unit confusion. RS4: plan/deviation/review docs contain no personal data.

### Testing expert
- R7: no E2E test references a refactored literal (values identical). R19: all extension-token mocks that cover the FAMILY_EXPIRED path include EXTENSION_TOKEN_REVOKE_REASON with exact values. RT1: mock-reality alignment verified (prisma.test still asserts identical defaults; ICU format matches). RT2: sync test, interpolation test, NOTIFICATION_BELL_LIMIT test, and the new guard test all non-vacuous (fail under realistic drift/deletion).

## Environment Verification Report
Phase 1 declared VE1 (integration needs Postgres), VE2 (extension + DB-Redis CI jobs not in pre-pr.sh), VE3 (iOS out of scope).
- All 14 contracts (C1–C14) are pure behavior-preserving refactors: `verified-local` via `npx vitest run` (full suite, exit 0), `npx next build` (exit 0, ×4 across waves), `npm run check:env-docs` (no drift), extension `npx vitest run` (769), cli `npx vitest run` (304). No contract required integration-only verification (values byte-identical; no schema/migration/SQL change) → VE1 not exercised, correctly.
- VE2: extension test suite run locally (verified-local); CI re-verifies.
- VE3: no iOS code touched (SC1).
- No `blocked-deferred` paths.

## Resolution Status
All findings across 3 rounds resolved. Loop terminated on Round 3 "No findings". F8 carries a documented intentional behavior change (worker depth-alert defaults aligned to canonical 600s/10_000) — surfaced to the user.

## Anti-Deferral note
F8 was a pre-existing inconsistency in a file changed by C14 (`audit-outbox-worker.ts`) → in scope, fixed now (not deferred). The fix is the correct single-source resolution (worker now matches the documented contract), accepted as the right direction rather than preserving the divergent worker default.
