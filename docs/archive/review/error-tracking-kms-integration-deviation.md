# Coding Deviation Log: error-tracking-kms-integration
Created: 2026-03-18

## Deviations from Plan

### D1: AwsKmsKeyProvider uses createRequire instead of dynamic import
- **Plan description**: Use `import("@aws-sdk/client-kms")` with module name as variable
- **Actual implementation**: Uses `createRequire(__filename)` + `_setKmsModuleLoader()` test hook
- **Reason**: Turbopack traces all `import()` calls (even with variable paths) and fails build when module is not installed. `createRequire` bypasses bundler static analysis entirely.
- **Impact scope**: `src/lib/key-provider/aws-kms-provider.ts`, `aws-kms-provider.test.ts`

### D2: next.config.ts serverExternalPackages
- **Plan description**: Not mentioned in plan
- **Actual implementation**: Added `@aws-sdk/client-kms` to `serverExternalPackages`
- **Reason**: Required alongside `createRequire` to prevent Turbopack from attempting to bundle the optional dependency
- **Impact scope**: `next.config.ts`

### D3: sentry-sanitize.ts uses Object.defineProperty for meta stripping
- **Plan description**: Cast error to `Record<string, unknown>` and set meta to undefined
- **Actual implementation**: Uses `"meta" in err` check and `Object.defineProperty`
- **Reason**: TypeScript strict mode rejects `Error as Record<string, unknown>` cast ("Index signature for type 'string' is missing in type 'Error'")
- **Impact scope**: `src/lib/sentry-sanitize.ts`

### D4: webauthn-server.test.ts needs key-provider re-initialization
- **Plan description**: Not mentioned in plan
- **Actual implementation**: Added `reinitKeyProvider()` in `beforeEach` for derivePrfSalt tests
- **Reason**: Tests use `vi.resetModules()` which clears the key-provider singleton. Without re-init, `getKeyProviderSync()` throws "not initialized".
- **Impact scope**: `src/lib/webauthn-server.test.ts`

### D5: Test setup initializes EnvKeyProvider singleton
- **Plan description**: Mentioned but not detailed
- **Actual implementation**: `src/__tests__/setup.ts` calls `_resetKeyProvider()` + `getKeyProvider()` at top level
- **Reason**: All tests using crypto functions need the key provider to be initialized before `getKeyProviderSync()` is called
- **Impact scope**: `src/__tests__/setup.ts`
