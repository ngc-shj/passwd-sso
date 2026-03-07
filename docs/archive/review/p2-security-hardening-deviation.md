# Coding Deviation Log: p2-security-hardening
Created: 2026-03-07

## Deviations from Plan

### D1: Argon2id test mock instead of real WASM
- **Plan description**: Add tests for Argon2id key derivation (round-trip, param validation, WASM unavailability fallback)
- **Actual implementation**: Mocked `argon2-browser` in tests using PBKDF2 stand-in because `argon2-browser` uses WASM which is unavailable in Node/Vitest environment
- **Reason**: `argon2-browser` is designed for browser WASM runtime; importing it in Vitest (Node.js) crashes with WASM load failure. The mock verifies integration plumbing (param passing, determinism, key derivation chain) without requiring actual Argon2id computation.
- **Impact scope**: Test file only (`crypto-client.test.ts`). Production code uses real `argon2-browser` WASM.

### D2: `argon2idHash` exported as separate function
- **Plan description**: Extend `deriveWrappingKeyWithParams()` for kdfType=1
- **Actual implementation**: Extracted `argon2idHash()` as a separate exported function called by `deriveWrappingKeyArgon2id()`, rather than inlining the argon2 import
- **Reason**: Allows the argon2-browser dynamic import to be mockable in tests. Also provides a clean seam for future Node.js native `argon2` binding substitution.
- **Impact scope**: `crypto-client.ts` — API surface unchanged for callers of `deriveWrappingKeyWithParams`

### D3: Vault unlock/data route uses `as Record<string, unknown>` cast
- **Plan description**: Add kdfMemory and kdfParallelism to Prisma select and JSON response
- **Actual implementation**: Used `(user as Record<string, unknown>).kdfType` cast pattern for all KDF fields
- **Reason**: Pre-existing TypeScript issue — Prisma can't narrow `select` type when using computed spread `...(!isExtensionToken && {...})` for ECDH fields. The cast is a workaround for this known Prisma 7 limitation.
- **Impact scope**: `vault/unlock/data/route.ts` — runtime behavior unchanged

### D4: Extension/CLI Argon2id support deferred
- **Plan description**: Steps 23-24 — Update extension crypto and CLI crypto to support Argon2id
- **Actual implementation**: Not implemented in this PR. Only CSP manifest updated for extension.
- **Reason**: Extension and CLI have separate crypto modules that need independent integration work. The core infrastructure (CSP, type definitions, API schema) is in place.
- **Impact scope**: Extension users creating new vaults will still use PBKDF2 until extension crypto is updated. No breaking change — existing vaults work unchanged.

### D5: Vault setup UI Argon2id default + fallback notification deferred
- **Plan description**: Step 22 — Update vault setup UI to use Argon2id by default; add fallback notification UI
- **Actual implementation**: Not implemented in this PR. Server-side API accepts kdfType=1 but client still sends kdfType=0.
- **Reason**: UI changes require careful UX design for the fallback notification and WASM availability detection. The server-side foundation is complete.
- **Impact scope**: New vault setups continue using PBKDF2 until UI is updated. Migration path is fully prepared.
