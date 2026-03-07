# Coding Deviation Log: p0-security-foundations

Created: 2026-03-07

## Deviations from Plan

### DEV-1: Crypto domain ledger has 9 HKDF info strings, not 8

- **Plan description**: 8 HKDF info strings documented
- **Actual implementation**: 9 found — `passwd-sso-vault-verification-v1` was
  not listed as an HKDF info string in the plan's table but exists in code
  as `VERIFICATION_PLAINTEXT` (used for encryption key verification, not HKDF).
  The CI script's regex matches `passwd-sso-*` patterns regardless of usage.
- **Reason**: The regex-based extraction doesn't distinguish between HKDF info
  strings and other constants using the same naming convention.
- **Impact scope**: CI script only. The ledger documents this constant in the
  "Other Crypto Constants" section, so verification passes correctly.

### DEV-2: CI script skips commented-out lines

- **Plan description**: Script greps for HKDF info strings in crypto files.
- **Actual implementation**: Added line-level comment filtering to skip `//`
  and `*` prefixed lines. This was needed because `crypto-emergency.ts`
  contains a commented-out reserved string `"passwd-sso-emergency-v2"`.
- **Reason**: Without filtering, the CI would flag a reserved-for-future
  string that has no active code usage.
- **Impact scope**: `scripts/check-crypto-domains.mjs` only.

### DEV-3: kdfParamsSchema simplified from plan

- **Plan description**: Schema included `kdfMemory: z.undefined()` and
  `kdfParallelism: z.undefined()` fields.
- **Actual implementation**: Omitted `kdfMemory` and `kdfParallelism` from
  the Zod schema entirely. The schema only validates `kdfType` and
  `kdfIterations`. Since the Zod schema uses `.optional()` on the entire
  object and unknown keys are stripped by default, sending `kdfMemory` in
  the request body is harmless (it's ignored, not stored).
- **Reason**: Simpler validation. `z.undefined()` would reject explicit
  `null` values which some clients might send. The DB columns remain nullable
  with no default, so they stay `null` unless explicitly set.
- **Impact scope**: `src/app/api/vault/setup/route.ts` validation only.

### DEV-4: check-crypto-domains.mjs test file deferred

- **Plan description**: `scripts/__tests__/check-crypto-domains.test.mjs`
  should be created with fixture-based tests.
- **Actual implementation**: Deferred to a follow-up commit. The CI script
  was validated manually by running it against the actual codebase.
- **Reason**: The script's exported functions (`extractHkdfInfoStrings`,
  `extractAadScopes`, etc.) are ready for unit testing but fixture setup
  requires creating mock crypto files, which adds complexity without
  blocking the core P0 deliverables.
- **Impact scope**: Test coverage for the CI script itself.
