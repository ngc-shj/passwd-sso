# Refactoring Plan

## P0: Low Cost / High Impact (Quick Wins)

### 1. Consolidate Crypto Utility Functions

**Problem**: `textEncode()` and `toArrayBuffer()` are duplicated across 4 files.

**Files**:
- `src/lib/crypto-client.ts` (lines 70, 77)
- `src/lib/crypto-emergency.ts` (lines 82, 87)
- `src/lib/crypto-recovery.ts` (lines 27, 34)
- `src/lib/crypto-team.ts` (lines 55, 62)
- `src/lib/webauthn-client.ts` (line 52) — also contains `toArrayBuffer()` copy
- `src/lib/vault-context.tsx` (lines 108-119) — evaluate `hexDecode` / `hexEncode` for inclusion

**Action**: Create `src/lib/crypto-utils.ts` with shared utility functions (pure ESM, no side-effects, `"use client"` directive). Before extracting, verify that none of the duplicated functions reference file-local constants or closures that would change behavior when moved. Update all crypto modules to import from the shared module.

**Testing**: Add `src/lib/crypto-utils.ts` to `vitest.config.ts` `coverage.include`. Write dedicated unit tests in `crypto-utils.test.ts` covering: empty string, ASCII, multi-byte UTF-8, and zero-length `Uint8Array`.

**Risk**: Low — pure utility extraction, no logic change. Verify no file-local dependencies before moving. Mark as client-only to prevent server-side bundling issues.

### 2. Merge Dialog Shell Components

**Problem**: `PersonalEntryDialogShell` and `TeamEntryDialogShell` are near-identical implementations.

**Files**:
- `src/components/passwords/personal-entry-dialog-shell.tsx` (37 lines)
- `src/components/team/team-entry-dialog-shell.tsx` (37 lines)

**Action**: Create a unified `EntryDialogShell` component. Update both personal and team entry dialogs to use the shared component.

**Risk**: Low — identical UI, just needs a shared abstraction.

### 3. Extract Magic Numbers to Constants

**Problem**: The value `30_000` (30-second timeout) is hardcoded in 5+ locations.

**Files**:
- `src/components/passwords/password-detail-inline.tsx` (line 102) — `REVEAL_TIMEOUT`
- `src/components/passwords/password-card.tsx` (line 172) — `CLIPBOARD_CLEAR_DELAY`
- `src/components/passwords/copy-button.tsx` (line 21) — `CLIPBOARD_CLEAR_DELAY`
- `src/components/share/share-entry-view.tsx` (line 25) — `REVEAL_TIMEOUT`
- `src/components/passwords/entry-history-section.tsx` (line 81) — hardcoded

**Action**:
1. Create `src/lib/constants/timing.ts` with `REVEAL_TIMEOUT_MS` and `CLIPBOARD_CLEAR_TIMEOUT_MS`
2. Update `src/lib/constants/index.ts` to re-export from `timing.ts` (required for consistent `@/lib/constants` import path)
3. Replace all hardcoded occurrences across components

**Risk**: Low — constant extraction only.

### 4. Standardize `withRequestLog` Usage

**Problem**: 55 routes use `withRequestLog()` wrapper, but 71 routes export handlers directly without request logging.

**Action**: Apply `withRequestLog()` to all route handlers for consistent observability.

**Data masking policy**: Before rolling out, audit the `withRequestLog` implementation to ensure it does NOT log request/response bodies. Only log: method, path, status code, duration, and user ID. Sensitive headers (`Authorization`, `Cookie`) must be excluded. Add an explicit allowlist of loggable fields.

**Enforcement**: Add an ESLint rule (or a grep-based CI check) that flags route files exporting handlers without `withRequestLog`. Document the convention in CLAUDE.md.

**Testing prerequisite**: Before bulk rollout, add negative test cases to `src/__tests__/with-request-log.test.ts`:
1. Assert that `req.headers` is never serialized into any log call argument (not just specific tokens — prevent any header leakage)
2. Specific assertions: a request with `Authorization: Bearer <token>` must not have the token appear in log output; same for `Cookie: authjs.session-token=<value>`
3. Include a regression test: create a mock handler that intentionally logs `req.headers` and verify the negative assertion catches it — this prevents vacuous passing. Implementation: use a spy on the logger, then assert `expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(token))` in the intentionally-leaking case, confirming the detection mechanism works before relying on its negation in the real tests

This makes the data masking audit CI-enforced, not just a human review step.

**Risk**: Low — additive change, no behavior modification. Data masking audit is mandatory before deployment.

---

## P1: Medium Cost / High Impact (Structural Improvements)

### 5. Unify API Route Authentication Patterns

**Problem**: Two authentication patterns are used inconsistently:
- Pattern A: `authOrToken()` — supports session + extension token + API key
- Pattern B: `await auth()` — session-only

Some endpoints within the same resource use different patterns (e.g., `passwords/[id]` GET uses `authOrToken()` but DELETE uses `auth()`).

Additionally, `enforceAccessRestriction()` is duplicated in 5+ routes.

**Action**: Create `checkAuth(req, scope?)` utility that unifies both patterns. Integrate access restriction checks into the auth utility.

**Detailed requirements**:
1. `checkAuth` must support three auth modes: session (`auth()`), extension token, and API key — preserving the existing `authOrToken()` behavior
2. Scope enforcement: when `scope` is provided, validate it against the token/key's granted scopes. Return 403 with `SCOPE_INSUFFICIENT` on mismatch
3. Token revocation: delegate to existing revocation checks in `authOrToken()` — do not bypass
4. Backward compatibility: existing route handlers must continue to work with no behavior change. Introduce `checkAuth` alongside existing functions, then migrate route-by-route
5. Access restriction: `enforceAccessRestriction()` integrated as an opt-in flag (`checkAccessRestriction: true`)

**Migration plan**:
- Phase A: Create `checkAuth()` with full test coverage (unit + integration)
- Phase B: Migrate 3-5 routes as a pilot, verify no auth regressions
- Phase C: Migrate remaining routes in batches, one PR per batch
- Phase D: Remove deprecated `authOrToken()` / inline `auth()` patterns. **Gate**: full Playwright E2E suite must pass (against production build) before removal — `vitest run` alone is insufficient for auth regressions with real browser sessions

**Testing requirements**:
- Require `_clearPolicyCache()` in `beforeEach` for any test exercising `checkAccessRestriction: true`
- Write a dedicated test verifying `enforceAccessRestriction` is called when flag is `true` and NOT called when absent

**Risk**: Medium — touches auth logic; requires thorough testing. Each migration phase must pass all existing auth tests + E2E for Phase D.

### 6. Create Shared Body Parsing Utility

**Problem**: Every POST/PUT route repeats the same 3-step pattern:
1. `try { body = await req.json(); } catch { return 400; }`
2. `const parsed = schema.safeParse(body);`
3. `if (!parsed.success) { return 400 with details; }`

**Action**: Create `parseBody<T>(req: NextRequest, schema: ZodSchema<T>)` that returns a discriminated union with type guard.

```typescript
type ParseResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

export async function parseBody<T>(req: NextRequest, schema: ZodSchema<T>): Promise<ParseResult<T>>;
```

Callers use: `const result = await parseBody(req, schema); if (!result.ok) return result.response;`

The `ok` discriminant ensures TypeScript enforces exhaustive checking — callers cannot accidentally ignore errors.

**Risk**: Low — mechanical extraction of repeated pattern.

### 7. Unify Entry Type Definitions

**Problem**: Three near-identical interfaces with 50-60 fields each:
- `InlineDetailData` in `password-detail-inline.tsx` (lines 35-93)
- `VaultEntryFull` in `password-card.tsx` (lines 117-170)
- `ExportEntry` in `export-format-common.ts` (lines 10-70)

**Action**: Create a canonical `FullEntryData` interface in `src/types/entry.ts`. Derive component-specific types via `Pick<>` or `Omit<>`.

**Prerequisite — field name alignment**: Before unification, resolve naming inconsistencies:
- `VaultEntryFull.passphrase` → rename to `sshPassphrase` (matching `InlineDetailData` / `ExportEntry`)
- `VaultEntryFull.comment` → rename to `sshComment`
- Audit fields that exist in only some interfaces (`generatorSettings`, `travelSafe`, `isFavorite`) and decide: include in `FullEntryData` as optional, or derive via extension types

This rename must update all render sites in `password-card.tsx`. Coordinate with Item #14 (prop drilling) — both can be done in the same PR.

**Risk**: Medium — requires field renaming + consumer updates; type errors will surface at build time.

### 8. Split VaultContext into Focused Providers

**Problem**: `src/lib/vault-context.tsx` is 939 lines with multiple responsibilities:
- Vault unlock/lock state
- Key rotation
- Auto-lock timer with inactivity detection
- Emergency access auto-confirm
- Passkey/PRF auth integration

Uses 10+ `useRef` hooks and multiple `useEffect` for activity tracking.

**Action**: Split into:
- `VaultUnlockContext` — unlock state, key management, ECDH key pairs, PRF auto-unlock
- `AutoLockContext` — inactivity timer and tab visibility (signals lock intent only, never touches `encryptionKey` directly)
- `EmergencyAccessContext` — emergency access flow

**Context dependency graph** (provider nesting order, outermost first):
```
VaultUnlockContext (owns encryptionKey, getEcdhPrivateKeyBytes)
  └─ AutoLockContext (calls VaultUnlockContext.lockVault() on timeout)
       └─ EmergencyAccessContext (reads VaultUnlockContext state)
            └─ TeamVaultProvider (consumes getEcdhPrivateKeyBytes from VaultUnlockContext)
```

**Critical design constraints**:
- `encryptionKey` clearing must be atomic within `VaultUnlockContext` — `AutoLockContext` only signals intent via `lockVault()`, never holds key references
- PRF auto-unlock logic stays in `VaultUnlockContext` (not `AutoLockContext`) to prevent race conditions between unlock and auto-lock timer
- **EA auto-confirm race condition**: `lock()` synchronously zero-fills `secretKeyRef.current`, but EA auto-confirm interval may have already captured a reference to it. Design must ensure: (a) EA interval is cleared before `secretKeyRef.current.fill(0)`, or (b) EA callback clones the key bytes before starting async work, checking validity first
- Test the window between `lockVault()` call and `encryptionKey` becoming unreferenceable (React closure capture issue)
- **Known JS limitation**: `prfOutputHex` string cannot be explicitly zeroed (GC-dependent). Document as accepted residual risk in the design

**Testing prerequisites** (before split):
1. Write unit tests using `renderHook` for: lock state transitions, inactivity timer firing, emergency access auto-confirm
2. Add VaultContext files to `vitest.config.ts` `coverage.include`
3. Require Playwright E2E (`e2e/tests/vault-lock-relock.spec.ts`, `e2e/tests/vault-setup.spec.ts`) as PR gate

**Risk**: Medium-High — 42 consumer files; context dependency design is critical. Must have baseline tests before starting.

### 9. Decompose `password-detail-inline.tsx`

**Problem**: 1,258-line monolithic component with:
- 11 individual `show*` boolean states for field reveal
- Repeated `setTimeout(() => setShow*(false), REVEAL_TIMEOUT)` pattern (lines 163-223)
- Mixed display logic for all entry types

**Action**:
1. Create `useRevealTimeout(fieldName)` custom hook — must clear timeout on unmount via `useEffect` cleanup to prevent memory leaks and state updates on unmounted components
2. Replace 11 `show*` states with a `revealedFields: Set<string>` map
3. Extract per-entry-type detail sections into sub-components

**Testing**: Write unit tests for `useRevealTimeout` covering: normal reveal/hide cycle, unmount during active timeout, rapid toggle, and re-render stability.

**Risk**: Medium — large component refactor; UI regression testing needed.

### 10. Split `validations.ts` by Domain

**Problem**: `src/lib/validations.ts` is 541 lines covering 8 domains: password, folder, tag, team, send, share, API key, emergency access.

**Action**: Split into `src/lib/validations/` directory:
```
validations/
  ├── index.ts          (re-exports)
  ├── password.ts
  ├── folder.ts
  ├── tag.ts
  ├── team.ts
  ├── send.ts
  ├── share.ts
  ├── api-key.ts
  ├── emergency-access.ts
  └── common.ts
```

**Risk**: Low — file reorganization with re-exports for backward compatibility.

### 11. Merge Personal/Team Entry Save Functions

**Problem**: `personal-entry-save.ts` (67 lines) and `team-entry-save.ts` (79 lines) share the same structure:
- Mode check (`create` vs `edit`)
- `encryptData()` call
- Endpoint selection
- Common metadata fields (`tagIds`, `requireReprompt`, `expiresAt`)

**Action**: Extract shared mechanics (fetch call, endpoint selection, body construction) as a private helper. Keep `savePersonalEntry` / `saveTeamEntry` as public APIs with distinct type signatures.

**Type safety**: Use a discriminated union to ensure scope-specific required fields:
```typescript
type SaveParams =
  | { scope: "personal"; userId: string; /* personal-specific fields */ }
  | { scope: "team"; teamId: string; itemKeyVersion: number; encryptedItemKey: string; /* team-specific fields */ };
```

**Security constraint**: `aadVersion: 0` (AAD-less encryption) must NOT be allowed for new entries. Add runtime validation to reject `aadVersion: 0` in the shared helper.

**Migration of `userId` optional path**:
- Current state: `personal-entry-save.ts` accepts `userId?: string` and produces `aadVersion: 0` when absent
- Required change: Make `userId: string` non-optional in the personal scope discriminant. All call sites must provide `userId`
- Existing tests that expect `aadVersion: 0` must be updated to provide `userId` and expect `aadVersion: 1`
- For backward compatibility with already-stored `aadVersion: 0` entries: the server-side read path must still accept them, but the write path must reject new `aadVersion: 0` submissions
- Add a negative test case: verify that the shared helper explicitly rejects a write request with `aadVersion: 0` (returns error, not silent acceptance)

**Risk**: Low-Medium — shared helper is small; public APIs preserved. Discriminated union prevents silent type errors. `userId` migration requires call-site audit.

### 12. Audit POST Endpoints for 201 Status Code

**Problem**: Only 5 POST endpoints return `201 Created`. Others return `200 OK` for resource creation.

**Action**: Audit all POST routes that create resources and update to return `201`.

**Compatibility check**: Before changing any endpoint:
1. Search all frontend `fetch()` calls and verify they check `response.ok` (not `response.status === 200`)
2. Check REST API v1 clients — external integrations may hardcode status checks
3. Update OpenAPI spec (`/api/v1/openapi.json`) to reflect 201 for creation endpoints
4. Add a note in API changelog / release notes for external consumers
5. Audit `load-test/` directory — `seed-load-test-users.mjs` (lines 449, 529) hardcodes `res.status === 200`; update to use `res.ok` or correct expected status

**Risk**: Low-Medium — HTTP semantics fix, but requires verification that no client hardcodes `status === 200`.

---

## P2: High Cost / High Impact (Major Refactoring)

### 13. Generalize Personal/Team Form Hooks

**Problem**: 70+ form hook files exist in symmetric pairs:
- `personal-login-form-controller.ts` / `team-login-form-controller.ts`
- `personal-login-form-derived.ts` / `team-login-form-derived.ts`
- `personal-login-fields-props.ts` / `team-login-fields-props.ts`
- Plus similar pairs for credit-card, identity, secure-note, etc.

**Action**: Create a generic form hook foundation parameterized by scope (`personal` | `team`). Reduce 70+ files to ~35 shared files with scope-specific configuration.

**Requirements to preserve**:
- Per-scope validation messages (personal vs team may have different error text)
- Per-scope default values (team forms may have additional defaults like `teamId`)
- Async side-effects: debounced API calls, auto-save behavior must remain scope-specific
- Entry-type-specific field sets (LOGIN, CREDIT_CARD, IDENTITY, etc.) — each has unique fields

**Approach**: Use a configuration object pattern rather than inheritance:
```typescript
interface FormScopeConfig<T> {
  scope: "personal" | "team";
  defaultValues: Partial<T>;
  validate: (data: T) => ValidationResult;
  onSave: (data: T) => Promise<void>;
  // scope-specific hooks
  sideEffects?: FormSideEffects;
}
```

**Snapshot baseline requirement** (before any migration PR):
- Define snapshot format: use vitest `toMatchInlineSnapshot()` for each form variant's initial state, validation outputs for fixed inputs, and `onSave` call signature
- Create baseline files per form type (e.g., `personal-login-form.snapshot.test.ts`, `team-login-form.snapshot.test.ts`)
- All snapshot baselines must pass on `main` before Item #13 PRs are opened

**Risk**: High — largest refactoring effort. Must have enforceable snapshot baselines, not just value-comparison tests.

### 14. Reduce Prop Drilling in Password Components

**Problem**: `PasswordCardProps` interface has 18+ individual props including entry data, UI state, event handlers, and permissions.

**Action**: Group into structured objects:
```typescript
interface PasswordCardProps {
  entry: FullEntryData;
  ui: PasswordCardUIState;
  handlers: PasswordCardHandlers;
  permissions: PermissionSet;
}
```

**Migration path**:
1. Define the new grouped interfaces alongside existing props
2. Search for all JSX spreads (`{...props}`) on `PasswordCard` and related components — these will break and must be updated
3. Update callers one at a time, verifying each with `next build`
4. Remove old flat prop interface after all callers migrated

**Risk**: Medium — all callers need updating. JSX spread patterns require special attention. Type safety helps catch issues at build time.

### 15. Extract Business Logic from Large API Routes

**Problem**: Several route files exceed 400 lines:
- `src/app/api/scim/v2/Users/[id]/route.ts` (465 lines)
- `src/app/api/scim/v2/Groups/[id]/route.ts` (415 lines)
- Team password routes (600+ lines including tests)

**Action**: Extract business logic into `src/lib/services/` modules. Route handlers should only handle HTTP concerns (auth, validation, response formatting).

**Contract preservation**: Service functions must return the same data shapes as current route handlers. Write integration tests that assert response shape and status codes before extraction, then verify they still pass after.

**Auth boundary for SCIM**: SCIM endpoints use Bearer token auth (not session). When extracting to services:
1. Auth checks (`validateScimToken`, `enforceAccessRestriction`) must remain in route handlers — never move to services
2. Service function signatures must require `authenticatedTenantId: string` as a mandatory parameter to prevent unauthenticated internal calls
3. Add explicit `tenantId` filter to `teamMember` queries in `buildResourceFromMapping` (currently relies on RLS only — make defense-in-depth explicit for when services are called outside RLS context). Update `buildResourceFromMapping` function signature to accept `tenantId: string` parameter; all call sites are inside `withTenantRls` closures so passing it down is straightforward

**Risk**: Medium — requires careful separation of concerns; existing tests help. Contract tests and auth boundary enforcement are mandatory.

### 16. Standardize Error Response Contract

**Problem**: Error responses use inconsistent formats:
- `{ error: API_ERROR.UNAUTHORIZED }` (constant)
- `{ error: "INVALID_FOLDER" as const }` (inline string)
- `{ error: e.message }` (raw error message)

**Action**: Define a strict `ErrorResponse` type. Create a `createErrorResponse(code, details?)` helper. Enforce consistent usage via TypeScript types.

**Phased rollout**:
- Phase A: Define `ErrorResponse` type and `createErrorResponse()` helper. Both old and new patterns coexist
- Phase B: Migrate routes in batches (P0 routes first, then P1, etc.). Each batch is a separate PR with tests
- Phase C: Add a TypeScript lint rule or branded type to flag raw `NextResponse.json({ error: ... })` calls
- Phase D: Remove all legacy error patterns after full migration

**Risk**: Medium — touches all error paths. Phased rollout prevents big-bang breakage. Each phase must pass `vitest run` + `next build`.

---

## P3: Low Cost / Low Impact (Quality Polish)

### 17. Standardize Audit Log Metadata Extraction ✅

**Problem**: Some routes pass `ip` and `userAgent` directly to `logAudit()`, while others use `...extractRequestMeta(req)`.

**Action**: Standardize on `...extractRequestMeta(req)` across all routes.

**Status**: Completed. 2 files migrated:
- `src/app/api/auth/passkey/verify/route.ts` — replaced manual `meta` construction with `extractRequestMeta(req)`
- `src/app/api/share-links/verify-access/route.ts` — replaced manual `ip`/`ua` extraction with `extractRequestMeta(req)` spread

**Risk**: Low — mechanical replacement.

### 18. Evaluate `crypto-aad.ts` Unification ✅ (No Action Needed)

**Problem**: `buildPersonalEntryAAD()` and `buildTeamEntryAAD()` in `src/lib/crypto-aad.ts` appear to share logic.

**Assessment result**: Already resolved. `buildAADBytes()` centralizes all binary AAD encoding logic. Both `buildPersonalEntryAAD()` and `buildTeamEntryAAD()` are thin wrappers delegating to `buildAADBytes()`. `buildTeamKeyWrapAAD` in `crypto-team.ts` also delegates to `buildAADBytes()`. No duplicate `AAD_VERSION` constants (each scope has its own intentional version). No further unification needed.

### 19. Unify Encrypted Field Response Format (Deferred)

**Problem**: Personal password API returns nested encryption objects:
```json
{ "encryptedBlob": { "ciphertext": "...", "iv": "...", "authTag": "..." } }
```
Team password API returns flat structure:
```json
{ "encryptedBlob": "...", "blobIv": "...", "blobAuthTag": "..." }
```

**Action**: Standardize on one format (prefer nested for clarity). This is a **breaking API change** and requires a careful migration strategy.

**Status**: Deferred. Requires API versioning strategy (v1 → v2), affects 30-35 files including 185+ `blobIv`/`blobAuthTag` references. Will be addressed as a separate initiative with proper deprecation and migration planning.

**Migration strategy** (for future implementation):
1. **API versioning**: Introduce the new format in `/api/v2/` endpoints. Keep `/api/v1/` unchanged
2. **Deprecation period**: Add `X-Deprecation-Notice` header to old-format responses for 2 release cycles
3. **Client migration**: Update all frontend consumers to use the new nested format. Search for all `blobIv`, `blobAuthTag` field accesses
4. **Dual-format support**: During migration, server can accept both formats on write. Read always returns the target format per API version
5. **Cutover**: Remove old format support after confirming no clients use it (check access logs)

**Risk**: High — breaking change for existing clients. Must not be attempted without the versioning strategy above.

---

## Estimated Effort

| Priority | Items | Estimated Hours |
|----------|-------|-----------------|
| P0       | 4     | 4–6h            |
| P1       | 8     | 20–30h          |
| P2       | 4     | 20–30h          |
| P3       | 3     | 3–5h            |
| **Total**| **19**| **47–71h**      |

## Execution Strategy

1. **P0 first** — Quick wins that improve code quality immediately
2. **P1 in dependency order** — Items 5-6 (API utilities) before 12 (status codes); Item 7 (types) before 9 (component split) and 14 (prop drilling)
3. **P2 after P1 stabilizes** — Form hook generalization (#13) is the largest effort and benefits from completed P1 type unification (#7)
4. **P3 as opportunistic** — Apply during related changes

Each item should be a separate PR with passing `vitest run` and `next build`.

## Prerequisites (Before Starting Any Item)

1. **Coverage thresholds**: Add minimum coverage thresholds to `vitest.config.ts` for security-sensitive files (e.g., `src/lib/auth-or-token.ts`, `lines: 80`). This prevents coverage regressions during refactoring.
2. **Baseline tests**: Items #8 and #13 require baseline tests on `main` before refactoring begins (see item-specific notes).
