# Coding Deviation Log: hardcoded-values-to-constants

Phase 2 implementation deviations from the locked plan. All values byte-identical; no runtime behavior change.

## D1 — C8: `src/app/s/[token]/download/route.ts` adopted SHARE_TYPE.FILE (side-fix, not in plan inventory)
- The plan's C8 SHARE_TYPE inventory did not list this file, but it contained a raw `"FILE"` shareType comparison of the same class.
- Action: replaced with `SHARE_TYPE.FILE` for consistency (R3 propagation — fixing the flagged class everywhere, not just listed sites).
- Value-identical. Aligned with feedback memory: do not leave sibling instances of the same anti-pattern.

## D2 — C2: `src/lib/constants/audit/audit.ts` time expression normalized (side-fix)
- A constant definition in this file used inline ms arithmetic matching the C2 forbidden pattern though not in the C2 inventory.
- Action: normalized to MS_PER_* base constant. Value-identical.

## D3 — C4: `src/hooks/use-watchtower.ts` WATCHTOWER_COOLDOWN_MS kept as re-export (not deleted)
- Plan said "delete the local export and import from timing.ts". Implemented as `export { WATCHTOWER_COOLDOWN_MS } from "@/lib/constants/timing"` to preserve backward compatibility for any existing importer of the hook's export.
- Rationale: zero-impact on existing importers; single source of truth still lives in timing.ts. Functionally equivalent to the plan's intent (no duplicate definition).

## D4 — C10: `src/app/[locale]/privacy-policy/page.tsx` uses CRYPTO_CONSTANTS.PBKDF2_ITERATIONS (not crypto-params directly)
- C10 ran in Wave 1 before C1 created `crypto-params.ts`. The page imports `CRYPTO_CONSTANTS` from `@/lib/crypto/crypto-client` (which now references crypto-params under the hood). Value-identical.
- Optional follow-up: switch the import to `@/lib/crypto/crypto-params` for directness; not required (CRYPTO_CONSTANTS is the documented public surface).

## D5 — Test side-fixes required by new imports/const-objects
- `src/app/api/auth/passkey/verify/route.test.ts`: mock of `@/lib/auth/tokens/extension-token` extended with `EXTENSION_TOKEN_REVOKE_REASON` (route now imports the const-object; bare mock left it undefined).
- `src/components/vault/recovery-key-banner.test.ts`: `@/lib/constants` mock extended with `LOCAL_STORAGE_KEY`.
- `src/lib/validations/common.server.test.ts`: removed the `NOTIFICATION_BELL_LIMIT` import/case (constant moved to common.ts per C13).
- All are test-infrastructure alignment to the production changes; no production behavior change.

## D6 — createTranslator import source (C10)
- Plan allowed `next-intl` or `use-intl/core`. Implemented with `next-intl` top-level export (verified available). The new test `tenant-admin-ttl-interpolation.test.ts` uses it.

## D7 — C14: exhaustive time-literal normalization (Phase 3, user-requested)
User's `rg 1000` / `rg _000` audit during Phase 3 showed the Phase 1 frequency-ranked inventory had missed many file-local time literals of the same class C2 targeted. Added contract C14: normalize ALL literals carrying a time unit to MS_PER_*/SEC_PER_* (constants directly, no secToMs/msToSec helper — rounding policy varies per site). ~60 files across src/lib, src/app/api, src/workers, src/components, src/hooks. Out of scope: count/length/page caps, bit lengths, PBKDF2 iteration counts. All values byte-identical.

## D8 — C1 named-exclusion correction: prisma.ts pool timeouts ARE time values
C1 originally listed `src/lib/prisma.ts:79 max: 600_000` as a named exclusion ("pool config, unrelated"). That was wrong: it is the `idleTimeoutMillis` env-bound max (10 min in ms). All 4 pool timeouts (connectionTimeoutMillis, idleTimeoutMillis, maxLifetimeSeconds [seconds → SEC_PER_*], statement_timeout) were normalized under C14. Only `max: envInt("DB_POOL_MAX", 20, {max: 200})` (connection count) stays. The PBKDF2 `600_000` exclusions in C1 remain valid.

## D9 — extension/cli residual time literals (Phase 3 follow-up to C14)
C11/C12 had normalized only a subset; the `rg` audit found more: extension file-local timeouts (PENDING_SAVE_TTL_MS, MIN_DELAY_MS, HYDRATION_TIMEOUT_MS, DETECT_DEBOUNCE_MS, AUTO_DISMISS_MS ×2, token-handler 60_000), extension `*/1000` (dpop-key iat, constants BRIDGE_CODE_TTL_MS, MatchList clipboard), cli (clipboard CLEAR_TIMEOUT_MS, oauth CALLBACK_TIMEOUT_MS + `/1000` display, totp Date.now()/1000). All normalized via each repo's own time.ts mirror; `.js` twins verified to hold no copies. Final audit: zero time-unit literals remain (only count/length caps + PBKDF2 + comments).

## D10 — extension-constants-sync.test.ts extractNumericConst extended for MS_PER_* expressions
Changing extension `BRIDGE_CODE_TTL_MS = 60 * 1000` → `MS_PER_MINUTE` broke the sync test's regex-based numeric extractor (returned undefined). Fixed the test to resolve MS_PER_SECOND/MS_PER_MINUTE before evaluating, preserving the strict value-equality check (still asserts 60000 === 60000). Test-infrastructure follow-through to the production change, not a relaxation.

## D11 — Phase 3 Round 1 Minor findings resolved
F1 crypto-client non-null assertion removed (`?? 65536` fallback chain, type-safe); F2 i18n test stale comment updated; T1/S2 PrivacyPolicy assertion derives from constant via Intl.NumberFormat; T2 recovery-key-banner.test single-sources the storage key from the mock; T3 NOTIFICATION_BELL_LIMIT positive-integer test added to common.test.ts; T4 refresh-route test mock gained EXTENSION_TOKEN_REVOKE_REASON (values copied from the real const-object).
