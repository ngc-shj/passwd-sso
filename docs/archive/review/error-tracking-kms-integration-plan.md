# Plan: error-tracking-kms-integration

## Context

Two P2 production-readiness items remain:
- **#218** Error tracking: global error boundary, explicit Sentry capture, Prisma error transformation
- **#109** KMS integration: abstract key loading behind a provider interface so master keys don't need to be plaintext in env vars

Current state: Pino structured logging, Sentry (opt-in), `withRequestLog` on 181 routes, dashboard error boundary — all exist. Missing: global-error.tsx, explicit captureException, Prisma error util. For KMS: 4 master keys loaded directly from `process.env` with no abstraction layer.

## Objective

1. Complete error tracking infrastructure for production readiness
2. Add KMS provider abstraction with EnvKeyProvider (default) and AwsKmsKeyProvider

## Requirements

### Functional
- Global error boundary catches all unhandled client errors
- Sentry explicitly captures server-side exceptions in `withRequestLog`
- Prisma errors mapped to standard API error codes
- KMS provider interface with env (default) and aws-kms implementations
- TTL-cached key loading for KMS provider with max stale duration
- Startup key validation
- Self-hosted fallback preserved (env provider)

### Non-functional
- No changes to existing 181 route handlers
- Sentry remains opt-in (no bundle size increase when unused)
- KMS provider remains opt-in (`KEY_PROVIDER=env` default)
- Dev/test key fallbacks preserved

## Technical Approach

### Implementation order: #218 first, then #109

Error tracking first so KMS implementation benefits from improved error reporting.

### Key design decisions
1. **`getKeySync()` on KeyProvider interface** — preserves synchronous call sites in crypto-server.ts, avoids changing 181 routes. KMS provider serves from cache (warmed at startup).
2. **Envelope encryption for AWS KMS** — encrypted data keys in env vars, KMS only decrypts them. Minimizes KMS API calls.
3. **Dynamic import for Sentry** — zero bundle cost when SENTRY_DSN unset.
4. **Prisma error util as opt-in helper** — new utility provided, existing per-route handling not rewritten in this PR.
5. **Error sanitizer for Sentry** — `sanitizeErrorForSentry()` scrubs hex64 patterns from `Error.message` and `Error.cause` before sending to Sentry.
6. **Max stale TTL for KMS** — after `maxStaleTtlMs` (default 2× TTL), `getKeySync()` throws instead of serving stale cached keys.

## Implementation Steps

### Part A: Error Tracking (#218)

#### Step 1: Global error boundary
- **New:** `src/app/global-error.tsx` (root app directory, NOT `[locale]/`)
- `"use client"`, renders own `<html><body>` (Next.js requirement for global-error)
- Hardcoded fallback strings (ja/en) — no i18n dependency (root layout may be broken)
- `useEffect` → `Sentry.captureException(error)` if `NEXT_PUBLIC_SENTRY_DSN` set (client-side env)
- Reset button to retry
- **Test:** `src/app/global-error.test.tsx` — mock `@sentry/nextjs`, verify `captureException` called with error prop, verify reset button calls `reset()` (React Testing Library)

#### Step 2: Error sanitizer for Sentry + explicit capture in withRequestLog
- **New:** `src/lib/sentry-sanitize.ts`
  - `sanitizeErrorForSentry(err: unknown): Error` — creates a sanitized copy:
    - Scrubs hex64 patterns (`/[0-9a-fA-F]{64}/g`) from `error.message` → `[redacted-key]`
    - Scrubs base64 patterns (>40 chars) from `error.message`
    - Recursively sanitizes `error.cause`
    - Strips Prisma `meta` field if present
  - **Test:** `src/lib/sentry-sanitize.test.ts`
- **Modify:** `src/lib/with-request-log.ts`
  - In catch block (after `reqLogger.error`): `vi.mock("@sentry/nextjs")` hoisted mock pattern for sync resolution
  - Call `sanitizeErrorForSentry(err)` before `captureException`
  - Fire-and-forget, wrapped in `.catch(() => {})` to prevent Sentry errors from affecting response
  - **Test:** `src/lib/with-request-log.test.ts` — add Sentry tests with hoisted `vi.mock("@sentry/nextjs")` for deterministic async behavior

#### Step 3: Prisma error transformation utility
- **New:** `src/lib/prisma-error.ts`
  - `mapPrismaError(error: unknown): { status: number; code: ApiErrorCode } | null`
  - P2002 → 409 `CONFLICT`, P2025 → 404 `NOT_FOUND`, P2003 → 409 `CONFLICT`
  - `PrismaClientInitializationError` → 503 `SERVICE_UNAVAILABLE`
  - Return type uses `ApiErrorCode` for type safety
  - Note: `CONFLICT` and `SERVICE_UNAVAILABLE` already exist in `api-error-codes.ts` — no additions needed
- **Modify:** `src/lib/api-response.ts` — add `prismaErrorResponse(error: unknown): NextResponse | null` helper
- **New:** `src/lib/prisma-error.test.ts` — parameterized tests with `it.each` covering P2002, P2003, P2025, PrismaClientInitializationError, unknown error → null

#### Step 4: Audit log forwarding documentation
- **New:** `docs/operations/audit-log-forwarding.md`
- Fluent Bit, Datadog Agent, CloudWatch Logs integration patterns
- Log schema reference, env var documentation

### Part B: KMS Integration (#109)

#### Step 5: KeyProvider interface and types
- **New:** `src/lib/key-provider/types.ts`
  - `KeyName = "share-master" | "verifier-pepper" | "directory-sync" | "webauthn-prf"`
  - `KeyProvider` interface: `getKey(name, version?)`, `getKeySync(name, version?)`, `validateKeys()`, `name`

#### Step 6: EnvKeyProvider implementation
- **New:** `src/lib/key-provider/env-provider.ts`
- Consolidates key loading from `crypto-server.ts`, `credentials.ts`, `webauthn-server.ts`
- Preserves dev/test fallbacks (verifier pepper SHA-256 derivation, directory-sync master key fallback)
- `getKeySync` returns directly from process.env (no cache needed)
- `validateKeys()` checks all required keys are present
- **Test:** `src/lib/key-provider/env-provider.test.ts`

#### Step 7: AwsKmsKeyProvider implementation
- **New:** `src/lib/key-provider/aws-kms-provider.ts`
- Envelope encryption: `KMS_ENCRYPTED_KEY_{NAME}` (base64 ciphertext in env) → KMS Decrypt → plaintext Buffer
- TTL-based in-memory cache (default 5min, configurable via `KMS_CACHE_TTL_MS`)
- **Max stale TTL:** `maxStaleTtlMs` (default 2× TTL). If KMS refresh fails, serve cached key until `maxStaleTtlMs` expires, then throw on `getKeySync()` and return 503
- `getKeySync` returns from cache, throws if cache miss or stale beyond max
- `@aws-sdk/client-kms` as optional peer dependency, dynamic import
- **Test:** `src/lib/key-provider/aws-kms-provider.test.ts` — mock KMS client with:
  - Cache hit test: 2 calls to `getKey()` → KMS called once
  - Cache expiry test: `vi.setSystemTime` past TTL → KMS called again
  - Max stale TTL test: KMS fails + stale beyond max → throws
  - TTL=0 test: no caching

#### Step 8: Provider factory and singleton
- **New:** `src/lib/key-provider/index.ts`
  - `getKeyProvider()` → async, creates singleton based on `KEY_PROVIDER` env
  - `getKeyProviderSync()` → sync accessor after initialization
- **Test:** `src/lib/key-provider/index.test.ts`

#### Step 9: Env validation update
- **Modify:** `src/lib/env.ts`
  - Add `KEY_PROVIDER: z.enum(["env", "aws-kms"]).default("env")`
  - Add `KMS_CACHE_TTL_MS` (optional)
  - superRefine: when `aws-kms`, require `AWS_REGION` and `KMS_ENCRYPTED_KEY_SHARE_MASTER` (required), plus any other `KMS_ENCRYPTED_KEY_*` for configured features

#### Step 10: Startup validation integration
- **Modify:** `src/instrumentation.ts`
  - **Guard:** `if (process.env.NEXT_RUNTIME === 'nodejs')` — KMS/key validation only in Node.js runtime, not Edge
  - After env validation, call `getKeyProvider()` → `validateKeys()`
- **Test:** `src/instrumentation.test.ts` (new) — `vi.mock("@/lib/key-provider")` + dynamic import of `register()`, verify `validateKeys()` called. Separate file from env.test.ts to avoid module interference

#### Step 11: Migrate ALL 4 key loading points to KeyProvider
- **Modify:** `src/lib/crypto-server.ts`
  - `getMasterKeyByVersion(version)` → `getKeyProviderSync().getKeySync("share-master", version)`
  - `getVerifierPepper()` → `getKeyProviderSync().getKeySync("verifier-pepper")`
- **Modify:** `src/lib/directory-sync/credentials.ts`
  - `getDirectorySyncKey()` → `getKeyProviderSync().getKeySync("directory-sync")`
- **Modify:** `src/lib/webauthn-server.ts`
  - `getPrfSecret()` → `getKeyProviderSync().getKeySync("webauthn-prf")`

#### Step 12: Documentation
- **Modify:** `docs/architecture/production-readiness.md` — update 1.6 and KMS status
- **New:** `docs/operations/kms-setup.md` — KMS provider configuration guide (env vars, AWS KMS setup, key rotation requires restart)

### Part C: Finalization

#### Step 13: Update production-readiness.md + vitest.config.ts
- Mark `1.6` Error tracking as ✅
- Add KMS integration status
- Add `src/lib/key-provider/**/*.ts` and `src/lib/prisma-error.ts` to `vitest.config.ts` `coverage.include`

## Key Files

| File | Action | Step |
|------|--------|------|
| `src/app/global-error.tsx` | New | 1 |
| `src/app/global-error.test.tsx` | New | 1 |
| `src/lib/sentry-sanitize.ts` | New | 2 |
| `src/lib/sentry-sanitize.test.ts` | New | 2 |
| `src/lib/with-request-log.ts` | Modify | 2 |
| `src/lib/with-request-log.test.ts` | Modify | 2 |
| `src/lib/prisma-error.ts` | New | 3 |
| `src/lib/prisma-error.test.ts` | New | 3 |
| `src/lib/api-response.ts` | Modify | 3 |
| `src/lib/key-provider/types.ts` | New | 5 |
| `src/lib/key-provider/env-provider.ts` | New | 6 |
| `src/lib/key-provider/env-provider.test.ts` | New | 6 |
| `src/lib/key-provider/aws-kms-provider.ts` | New | 7 |
| `src/lib/key-provider/aws-kms-provider.test.ts` | New | 7 |
| `src/lib/key-provider/index.ts` | New | 8 |
| `src/lib/key-provider/index.test.ts` | New | 8 |
| `src/lib/env.ts` | Modify | 9 |
| `src/instrumentation.ts` | Modify | 10 |
| `src/instrumentation.test.ts` | New | 10 |
| `src/lib/crypto-server.ts` | Modify | 11 |
| `src/lib/directory-sync/credentials.ts` | Modify | 11 |
| `src/lib/webauthn-server.ts` | Modify | 11 |
| `docs/operations/audit-log-forwarding.md` | New | 4 |
| `docs/operations/kms-setup.md` | New | 12 |
| `docs/architecture/production-readiness.md` | Modify | 13 |
| `vitest.config.ts` | Modify | 13 |

## Testing Strategy

- Unit tests for all new modules (prisma-error, sentry-sanitize, key-provider/*)
- `global-error.test.tsx` with React Testing Library — verify Sentry capture and reset
- Existing `crypto-server.test.ts` must pass unchanged (EnvKeyProvider preserves behavior)
- Mock `@aws-sdk/client-kms` for AwsKmsKeyProvider tests with TTL cache verification
- Hoisted `vi.mock("@sentry/nextjs")` for withRequestLog Sentry tests (deterministic async)
- `instrumentation.test.ts` (separate file) with `vi.mock` + dynamic import for isolation
- Parameterized Prisma error tests with `it.each`
- Test `validateKeys()` startup path (mock key provider)
- `npx vitest run` + `npx next build` must pass

## Considerations & Constraints

- **Out of scope:** Rewriting existing per-route Prisma error handling (gradual migration)
- **Out of scope:** HashiCorp Vault provider (can be added later following same interface)
- **Out of scope:** OpenTelemetry distributed tracing
- **Risk:** `getKeySync` throws on cache miss for KMS provider — mitigated by startup warmup in `register()` + background TTL refresh. Max stale TTL (2× TTL) limits indefinite stale key usage.
- **Risk:** `global-error.tsx` without i18n — acceptable trade-off for reliability (Next.js requires own html/body)
- **Risk:** Error messages may contain key material — mitigated by `sanitizeErrorForSentry()` scrubbing hex64/base64 patterns before `captureException`
- **Constraint:** Key rotation with KMS requires service restart (or redeploy) to pick up new encrypted data keys. Document in kms-setup.md.
- **Constraint:** Edge Runtime — KMS validation only runs in Node.js runtime (`NEXT_RUNTIME === 'nodejs'` guard)
- **Dependency:** `@aws-sdk/client-kms` as optional peer dep (not added to dependencies, users install when needed)
