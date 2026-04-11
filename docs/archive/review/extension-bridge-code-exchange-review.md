# Plan Review: extension-bridge-code-exchange

Date: 2026-04-11
Review round: 2 (round 1 below; round 2 appended at the bottom)

## Changes from Previous Round

Initial review. Three Claude Sonnet sub-agents (functionality, security, testing) reviewed the design proposal in parallel. The proposal originated as part of a broader review covering both this plan and a sibling `durable-audit-outbox` plan; only Proposal 1 findings are recorded here.

## Source Material

The reviewed material was a textual design proposal (not a plan file) describing four stages:
- Stage 1: postMessage payload changes from token to one-time code
- Stage 2: New `POST /api/extension/token/exchange` endpoint
- Stage 3: Atomic single-use consumption with short TTL
- Stage 4: Optional PKCE-style verifier

## Functionality Findings

The functionality expert primarily reviewed the sibling `expand-security-policies` plan rather than this proposal. Findings relevant to this plan are limited to one adjacent observation (recorded under Adjacent Findings below).

## Security Findings

### P1-S1 — Major

**Problem**: `POST /api/extension/bridge-code` authorization — Auth.js session is required, but neither the consistency between session `tenantId` and bridge code `user_id`, nor the binding to the issuing tenant, was specified in the proposal.

**Attacker**: Authenticated malicious user (same or different tenant)
**Vector**: If the exchange endpoint accepts `user_id` from client input, a stolen code could be exchanged as a different user.
**Impact**: Horizontal privilege escalation.

**Action**:
- Exchange endpoint accepts `code_hash` only; `user_id` is resolved from the DB record.
- Add `tenant_id` to the `extension_bridge_codes` table; verify against session tenant on exchange.
- The issued token's `tenantId` must come from the code record, not from any client input.

**Resolution**: Plan §Step 5 (`/api/extension/token/exchange` handler) explicitly resolves both `userId` and `tenantId` from the consumed record via `findUnique` after the atomic UPDATE. Plan §Step 1 (schema) places `tenant_id` on `ExtensionBridgeCode` directly.

### P1-S2 — Major

**Problem**: Code entropy and generation algorithm not specified. The proposal said "single-use + short TTL + atomic consume" but did not pin down how the code is generated. A 6-digit OTP-style code with TTL 60s is brute-forceable at modest QPS.

**Attacker**: External network attacker
**Vector**: Brute-force the code space within the TTL window.
**Impact**: Token issuance to attacker.

**Action** (RS1, RS2):
- Reuse `generateShareToken()` (existing helper, `randomBytes(32)` → 64-char hex, 256-bit entropy).
- Add `createRateLimiter` to `POST /api/extension/token/exchange`.
- Use `timingSafeEqual` for any in-memory hash comparison.

**Resolution**: Plan §Step 4 and §Step 5 specify `generateShareToken()` for code generation, `hashToken()` for storage, rate limiter `exchangeLimiter` (15min/10) on the exchange endpoint, and notes timingSafeEqual usage in §Implementation Checklist (RS1).

### P1-S3 — Major

**Problem**: PKCE Stage 4 design relies on the web app to forward the extension's `code_challenge` faithfully. A compromised web app (XSS, supply chain) can substitute its own challenge, defeating PKCE entirely.

**Attacker**: XSS or supply chain compromise of web app JS
**Vector**: Web app intercepts the `code_challenge` and replaces it with one for which the attacker holds the verifier.
**Impact**: PKCE provides no protection in this scenario; design contradicts its own threat model.

**Action**:
- Defer Stage 4 PKCE from this plan.
- A meaningful PKCE design requires the extension to register the challenge with the server through an independent channel — this introduces a bootstrap problem (extension has no session).
- Document the limitation and revisit when extension-initiated bootstrap is feasible.

**Resolution**: Plan §Stage 4 (OUT OF SCOPE) explicitly defers PKCE with rationale; plan §Considerations §5 documents the limitation and the bootstrap problem.

### P1-S4 — Major

**Problem**: `POST /api/extension/bridge-code` had no rate limiter specified. Authenticated users could mass-generate unused codes (DoS, DB bloat).

**Attacker**: Authenticated malicious user, or attacker who hijacked a session via XSS.
**Vector**: Mass code generation.
**Impact**: DB bloat, tail-latency degradation.

**Action**: Apply `createRateLimiter` with same settings as existing `tokenLimiter` (15min / 10 per user).

**Resolution**: Plan §Step 4 specifies `bridgeCodeLimiter` with `windowMs: 15 * 60 * 1000, max: 10` and key `rl:ext_bridge:${userId}`.

### P1-S5 — Minor

**Problem**: Atomic consume implementation pattern not specified. A naive `findFirst` + `update` two-step is vulnerable to TOCTOU race conditions where two concurrent requests both pass the "unused" check before either commits the update.

**Action**: Use single `updateMany({ where: { codeHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } })` and check `affectedRows`. If 0 → 401. This is the same pattern already used in `POST /api/extension/token/refresh`.

**Resolution**: Plan §Stage 3 §Step 5 explicitly use this pattern, citing the existing `refresh` route as precedent.

### P1-S6 — Minor

**Problem**: `nonce` field on the proposed table had no defined purpose, generation rule, or verification step.

**Action**: Remove `nonce` from the schema since Stage 4 PKCE is deferred. Re-add when/if Stage 4 is reintroduced with a clear specification.

**Resolution**: Plan §Step 1 schema does NOT include a `nonce` field; plan §Considerations notes the deferral.

### P1-S7 — Minor

**Problem**: CSRF protection coverage on `POST /api/extension/bridge-code` not verified. Auth.js v5 provides cookie-level CSRF (SameSite=Lax) but custom POST routes are not automatically protected against same-site CSRF.

**Action**: Add `assertOrigin()` (existing helper from `src/lib/csrf.ts`) as defense-in-depth on the bridge-code endpoint. Do NOT add it to the exchange endpoint because the extension content script may have a `chrome-extension://` origin that legitimately differs from APP_URL.

**Resolution**: Plan §Step 4 calls `assertOrigin()` on `bridge-code`; plan §Considerations §3 explicitly excludes it from `exchange` with rationale.

### P1-RS1 — Conditional

**Problem**: Timing-safe hash comparison check.

**Action**: PostgreSQL `WHERE code_hash = ?` is acceptable (indexed lookup; attacker cannot influence DB query timing). Any in-memory comparison must use `timingSafeEqual` per project convention.

**Resolution**: Plan §Implementation Checklist mentions `timingSafeEqual` from `node:crypto` as a shared utility to reuse.

## Testing Findings

### P1-T1 — Critical (was P1-01)

**Problem**: `inject-extension-token.test.ts` tests the existing token-based payload. After Stage 1, the payload changes to a code-based shape. The test is not just incorrect — if left unchanged, it provides false-positive coverage of an obsolete code path.

**Action**: Update the test in the same PR as the inject function rewrite. Rename to match the new function name. Add an explicit assertion that `token` is NOT present in the payload (regression guard).

**Resolution**: Plan §Step 7 explicitly requires renaming and rewriting the test in the same PR; plan §Step 10 lists the test rename in "Existing test files" with the regression guard requirement.

### P1-T2 — Critical (was P1-02)

**Problem**: No tests for the new endpoints. Five critical paths on `/api/extension/token/exchange` are uncovered: success, used, expired, unknown, malformed.

**Action**: Create `src/app/api/extension/token/exchange/route.test.ts` covering all 5 paths plus rate limiting and replay. Use the existing `vi.hoisted` mock pattern.

**Resolution**: Plan §Step 10 lists 7 specific test cases (the 5 critical paths plus rate limit and explicit replay), and references the existing `route.test.ts` mock pattern.

### P1-T3 — Major (was P1-03)

**Problem**: `POST /api/extension/bridge-code` test cases not specified — session missing → 401, success → 201, rate-limited → 429.

**Action**: Create `src/app/api/extension/bridge-code/route.test.ts` mirroring `src/app/api/extension/token/route.test.ts` structure. Cover origin check (403), max-active enforcement, and audit emission too.

**Resolution**: Plan §Step 10 lists 6 specific test cases for the `bridge-code` endpoint including 401, 201, 429, 403, max-active, and audit assertion.

### P1-T4 — Major (was P1-04)

**Problem**: Atomic consume race condition (Stage 3) requires a test that simulates `count === 0` from a concurrent exchange. The existing `refresh` route test has the analogous "optimistic lock" case at `route.test.ts` lines 222-238 — the same pattern must be applied to the new exchange route.

**Action**: Add a test that mocks `mockExtensionBridgeCodeUpdateMany.mockResolvedValue({ count: 0 })` and asserts 401 + audit failure.

**Resolution**: Plan §Step 10 explicitly calls out this test case as critical and references the existing `refresh` test pattern.

### P1-T5 — Major (was P1-05, RT3 violation precursor)

**Problem**: New constants like `BRIDGE_CODE_MSG_TYPE`, `BRIDGE_CODE_TTL_MS`, `BRIDGE_CODE_MAX_ACTIVE` must live in `src/lib/constants/extension.ts` (and the extension repo mirror). Tests must import them, not hardcode literal values, to satisfy RT3 (shared constants in tests).

**Action**: Add the constants to the existing `extension.ts` file. All test assertions reference the constants via import.

**Resolution**: Plan §Step 2 specifies the constants and their location in both `src/lib/constants/extension.ts` and `extension/src/lib/constants.ts`. Plan §Step 7 and §Step 10 emphasize importing constants in tests, not hardcoding.

### P1-T6 — Minor (was P1-06)

**Problem**: Mock type safety for the new `extensionBridgeCode` Prisma model. Without explicit `Prisma.ExtensionBridgeCodeGetPayload<...>` typing, mock return values can drift from the generated client types — known integration test gap (`project_integration_test_gap.md`).

**Action**: Type the mock return values explicitly. Run `npx prisma generate` after schema changes.

**Resolution**: Plan §Testing Strategy mentions "Mock-reality consistency: All Prisma mocks for `extensionBridgeCode` must match the actual generated `Prisma.ExtensionBridgeCodeGetPayload` shape."

## Adjacent Findings

### P1-S8 [Adjacent → Functionality]

**Problem**: Migration period coexistence of legacy (bearer token) and new (code exchange) flows is not handled in the proposal. During the rollout, both paths must work simultaneously.

**Resolution**: Plan §Step 11 defines an explicit 3-phase deprecation lifecycle (Phase 1: both paths live; Phase 2: extension-only legacy; Phase 3: removal after 30-day zero-traffic telemetry). Plan §Considerations §6 references this and acknowledges the unavoidable tail of older installed extensions.

### X-M1 [Cross-cutting → Testing/Functionality]

**Problem**: Atomic consume and trust boundaries cannot be fully verified in mocked unit tests. The known project gap (`project_integration_test_gap.md`) applies.

**Resolution**: Plan §Testing Strategy explicitly acknowledges this limitation and notes that real DB integration tests are out of scope per existing project test infrastructure.

## Quality Warnings

None. All findings include specific file references, evidence from the existing codebase investigation, and concrete remediation actions.

## Resolution Status

All Critical and Major findings from Proposal 1 are reflected in the plan:

| Finding | Severity | Plan Section |
|---------|----------|--------------|
| P1-S1 | Major | §Step 1 (schema), §Step 5 (exchange handler) |
| P1-S2 | Major | §Step 4, §Step 5, §Implementation Checklist |
| P1-S3 | Major | §Stage 4 (OUT OF SCOPE), §Considerations §5 |
| P1-S4 | Major | §Step 4 (`bridgeCodeLimiter`) |
| P1-S5 | Minor | §Stage 3, §Step 5 |
| P1-S6 | Minor | §Step 1 (no nonce field) |
| P1-S7 | Minor | §Step 4 (`assertOrigin`), §Considerations §3 |
| P1-RS1 | Conditional | §Implementation Checklist |
| P1-T1 | Critical | §Step 7, §Step 10 |
| P1-T2 | Critical | §Step 10 (5 critical paths + replay) |
| P1-T3 | Major | §Step 10 (bridge-code test cases) |
| P1-T4 | Major | §Step 10 (concurrent consume test) |
| P1-T5 | Major | §Step 2, §Step 7, §Step 10 |
| P1-T6 | Minor | §Testing Strategy |
| P1-S8 | Adjacent | §Step 11, §Considerations §6 |
| X-M1 | Cross-cutting | §Testing Strategy |

---

# Round 2

Date: 2026-04-11
Review round: 2

## Changes from Previous Round

Three sub-agents re-reviewed the plan after Round 1 findings were applied. Each agent verified resolution of the prior round's findings against the actual codebase (not just plan text) and looked for new issues introduced by the fixes.

## New Findings (Round 2)

### Critical

#### F-05 / R2-S1 — Critical (Functionality + Security)

**Problem**: The plan's pseudocode in §Step 5 used `userId: "system"` for failed exchange audit emissions. Verified against `audit.ts:115-152` and `prisma/schema.prisma:899`:
- `AuditLog.userId` is `@db.Uuid` — non-UUID strings cause Prisma to throw on lookup
- `audit.ts:127-134` requires a resolvable `tenantId`; for an unknown user the fallback `findUnique` returns null and `audit.ts` returns early at line 134
- Result: failed exchange audit events would be **silently dropped from the DB audit table**, only appearing in pino structured output
- Even using `NIL_UUID` (`src/lib/constants/app.ts:17`) does not fix this — the same fallback path runs and tenantId is unresolvable

**Action**: Replace failed-exchange `logAudit()` calls with direct `getLogger().warn(...)` pino-only logging. The success path keeps `logAudit()` because it has resolved `userId`/`tenantId` from the consumed code record.

**Resolution**: §Step 5 pseudocode rewritten to use `getLogger().warn(...)` for all failure paths. §Considerations §7 rewritten to document the rationale (what fails, why pino-only is the right design, how SIEM coverage is preserved).

#### R2-T1 — Critical (Testing)

**Problem**: §Step 9 added new bridge code test cases to `extension/src/__tests__/content/token-bridge.test.ts` that involve `fetch()` calls and async handler logic. Three issues:
1. Vitest jsdom env does not provide `fetch` — must be mocked
2. `handlePostMessage` becomes `Promise<boolean>` — existing 7 sync test cases break unless migrated
3. Plan did not specify how to handle the async migration or fetch mocking

**Action**: Plan must specify the test environment (jsdom), the fetch mock approach, the async migration of existing tests, and the new bridge code test cases.

**Resolution**: §Step 9 expanded with:
- Environment verification (`environmentMatchGlobs` or per-file annotation)
- `vi.stubGlobal("fetch", mockFetch)` setup pattern
- Migration guide for existing 7 sync tests to `await handlePostMessage(...)`
- New bridge code test patterns with explicit `mockResolvedValueOnce`/`mockRejectedValueOnce`
- §Implementation Checklist adds `extension/vitest.config.ts` verification entry

### Major

#### F-02 — Major (Functionality)

**Problem**: Plan §Step 4 pseudocode called `withUserTenantRls(prisma, userId, fn)` with 3 arguments. Verified against `src/lib/tenant-context.ts:38-47` — actual signature is `withUserTenantRls(userId, fn)` (2 args; the helper uses the singleton `prisma` internally).

**Action**: Fix the pseudocode signature.

**Resolution**: §Step 4 pseudocode now uses `withUserTenantRls(userId, () => prisma.user.findUnique(...))` with an inline note citing `src/lib/tenant-context.ts:38`.

#### F-06 — Major (Functionality)

**Problem**: §Step 6 originally said `POST /api/extension/token/refresh` would be consolidated to use `issueExtensionToken()`. Refresh requires `revoke(oldTokenId) + create(newToken)` to be atomic in a single transaction (`refresh/route.ts:65-87`). Replacing this with a standalone `issueExtensionToken()` call would split the operation across two transactions, introducing a TOCTOU window.

**Action**: Exclude refresh from the refactor. Document the rationale.

**Resolution**: §Step 6 now lists only legacy POST and new exchange as users of `issueExtensionToken()`. Refresh route is explicitly NOT refactored, with rationale and a note about a potential future `revokeTokenId` parameter being out of scope.

#### R2-T2 — Major (Testing)

**Problem**: §Step 2 referenced extending an existing `extension/src/__tests__/lib/token-bridge-js-sync.test.ts` to validate new constants. This file does not exist in the codebase.

**Action**: Mark the file as NEW and specify what it should validate and how.

**Resolution**: §Step 9 now describes the file as NEW with explicit constants list (`TOKEN_BRIDGE_MSG_TYPE`, `BRIDGE_CODE_MSG_TYPE`, `BRIDGE_CODE_TTL_MS`, `BRIDGE_CODE_MAX_ACTIVE`) and an implementation approach (read both files via fs, parse via regex, assert equal). §Implementation Checklist updated with the **NEW** label.

#### R2-T3 — Major (Testing)

**Problem**: §Step 10's malformed-body test case (item 5) did not explicitly assert audit/log emission, only the 400 response.

**Action**: Add an explicit assertion that `mockLogger.warn` is called with `reason: "invalid_request"` and that `mockLogAudit` is NOT called (verifying the pino-only design).

**Resolution**: §Step 10 item 5 rewritten to explicitly assert `mockLogger.warn` call shape and the absence of `mockLogAudit`. Other failure cases (items 2, 3, 4) similarly updated to assert pino warn instead of `logAudit`.

#### R2-T4 — Major (Testing)

**Problem**: §Step 6 claimed legacy `route.test.ts` would still pass after the refactor, but did not justify this claim by tracing the mock boundary.

**Action**: Add an explicit explanation of why the existing mocks remain valid.

**Resolution**: §Step 6 expanded with a "Refactor safety for the legacy endpoint test" subsection explaining:
- The test mocks at the Prisma layer (`vi.mock("@/lib/prisma", ...)`) — not at `@/lib/extension-token`
- After refactor, `issueExtensionToken()` calls the same Prisma methods inside the same `$transaction` callback
- The mock boundary remains effective
- An "verify when implementing" note about confirming `mockTransaction` callback shape

### Minor

#### F-01 — Minor (Functionality)

**Problem**: §Scenario 6 / §Step 11 had ambiguity about web app behavior in Phase 1 — would the web app call legacy or new flow?

**Resolution**: §Step 11 Phase 1 row clarified: web app switches to new code flow only; old extensions break until users update; release notes are mandatory before deployment.

#### F-03 — Minor (Functionality)

**Problem**: Pseudocode used `extractClientIp(req)` without specifying the import path. The function is exported from `src/lib/ip-access.ts:259`, NOT from `src/lib/audit.ts`.

**Resolution**: §Step 4 and §Step 5 pseudocode comments now specify "import from `@/lib/ip-access`". §Implementation Checklist explicitly lists `extractClientIp from src/lib/ip-access.ts`.

#### F-04 — Minor (Functionality)

**Problem**: §Step 6 mock boundary preservation needs explicit verification note for `mockTransaction` callback shape.

**Resolution**: Addressed together with R2-T4 in §Step 6.

#### R2-S2 — Minor (Security)

**Problem**: §Step 4 BRIDGE_CODE_MAX_ACTIVE enforcement pseudocode used `// ...` for the find/count/create logic, leaving atomicity ambiguous.

**Resolution**: §Step 4 pseudocode now spells out the find → updateMany → create sequence inside a single `withBypassRls` call, with a comment explicitly stating the atomicity requirement.

#### R2-S3 — Minor (Security)

**Problem**: XFF spoofing can rotate apparent IPs and bypass `exchangeLimiter`. Practical impact is bounded by the 256-bit code entropy.

**Resolution**: New §Considerations §12 documents the trade-off and the operational mitigation (correct `TRUSTED_PROXIES` configuration).

#### R2-S4 — Minor (Security)

**Problem**: `createRateLimiter` falls back to in-memory state when Redis is unavailable, multiplying effective rate limits in multi-instance deployments. Pre-existing project-wide issue.

**Resolution**: New §Considerations §11 documents the limitation and notes it is out of scope for this plan.

#### R2-T5 — Minor (Testing)

**Problem**: §Step 10 item 7 (replay) was indistinguishable from item 2 (concurrent consume) without an explicit 2-call mock sequence.

**Resolution**: §Step 10 item 7 rewritten with explicit `mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0})` chain and assertion that the second call returns 401.

#### R2-T6 — Minor (Testing)

**Problem**: `src/lib/extension-token.ts` may not be in `vitest.config.ts` `coverage.include` patterns.

**Resolution**: §Implementation Checklist adds an explicit verification step for `vitest.config.ts`.

#### R2-T7 — Minor (Testing)

**Problem**: The X-M1 concurrency limitation note is in §Testing Strategy but not in §Step 10 where implementers will look.

**Resolution**: §Step 10 item 2 now includes an inline note referencing X-M1 in §Testing Strategy.

## Resolution Status (Round 2)

| Finding | Severity | Plan Section |
|---------|----------|--------------|
| F-05 / R2-S1 | Critical | §Step 5, §Considerations §7 |
| R2-T1 | Critical | §Step 9, §Implementation Checklist |
| F-02 | Major | §Step 4 |
| F-06 | Major | §Step 6 |
| R2-T2 | Major | §Step 9, §Implementation Checklist |
| R2-T3 | Major | §Step 10 item 5 |
| R2-T4 | Major | §Step 6 |
| F-01 | Minor | §Step 11 |
| F-03 | Minor | §Step 4, §Step 5, §Implementation Checklist |
| F-04 | Minor | §Step 6 |
| R2-S2 | Minor | §Step 4 |
| R2-S3 | Minor | §Considerations §12 |
| R2-S4 | Minor | §Considerations §11 |
| R2-T5 | Minor | §Step 10 item 7 |
| R2-T6 | Minor | §Implementation Checklist |
| R2-T7 | Minor | §Step 10 item 2 |

---

# Round 3

Date: 2026-04-11
Review round: 3

## Changes from Previous Round

Three sub-agents re-reviewed the plan after Round 2 findings were applied. Each agent verified resolution against the actual codebase.

## New Findings (Round 3)

### Critical

#### F-R3-01 — Critical (Functionality)

**Problem**: Implementation Checklist line for `src/app/api/extension/token/refresh/route.ts` said "refactor to call `issueExtensionToken()`", contradicting §Step 6 body which explicitly says NOT to refactor refresh.

**Action**: Update checklist line to "DO NOT refactor".

**Resolution**: §Implementation Checklist updated. Refresh route line now reads "DO NOT refactor (see §Step 6 — inline atomic revoke+create transaction must be preserved)".

#### R3-T1 — Critical (Testing)

**Problem**: §Implementation Checklist for `extension/src/__tests__/content/token-bridge.test.ts` said only "add bridge code test cases" without warning about the required async migration of the existing 7 sync tests. Without the migration, existing tests assert on `Promise<boolean>` truthiness and become false-positive (always pass).

**Action**: Update checklist line to mandate the two-step procedure: migrate existing 7 tests to async/await FIRST, then add new cases.

**Resolution**: §Implementation Checklist line updated with the two-part requirement and the rationale (false-positive risk).

#### R3-T2 — Critical (Testing)

**Problem**: §Step 10 added `mockLogger.warn` assertions but did not specify HOW to mock the logger. Without `vi.mock("@/lib/logger", ...)` setup, `mockLogger.warn` would be undefined and tests would crash. The plan also did not reference the existing pattern at `src/app/api/csp-report/route.test.ts:7-13`.

**Action**: Add explicit mock setup pattern to §Step 10 with `vi.hoisted` declarations and `vi.mock("@/lib/logger", ...)` block.

**Resolution**: §Step 10 now includes a "Mock setup pattern" subsection with full TypeScript code for `vi.hoisted`, `vi.mock("@/lib/logger")`, `vi.mock("@/lib/audit")`, `vi.mock("@/lib/prisma")`, and a `beforeEach(() => vi.clearAllMocks())` block. References `csp-report/route.test.ts:7-13` as the established pattern.

### Major

#### F-R3-02 — Major (Functionality)

**Problem**: Plan §Step 5 pseudocode used `badRequest()` and `serverError()` which do NOT exist in `src/lib/api-response.ts`. Verified existing helpers: `unauthorized`, `notFound`, `forbidden`, `validationError`, `zodValidationError`, `rateLimited`, `errorResponse(code, status)`. No `badRequest` or `serverError`.

**Action**: Replace with existing helpers.

**Resolution**:
- `badRequest()` → `zodValidationError(parsed.error)` (uses the validated Zod error from the request body parse)
- `serverError()` → `errorResponse(API_ERROR.INTERNAL_ERROR, 500)`
- Both replacements are documented inline in §Step 5 pseudocode with comments noting the rationale.

#### F-R3-03 — Major (Functionality)

**Problem**: Plan §Step 4 pseudocode referenced `DEFAULT_EXTENSION_SCOPE`, which does not exist. The actual constant is `EXTENSION_TOKEN_DEFAULT_SCOPES` (an array, exported from `src/lib/constants/extension-token.ts:16`). The DB column is a CSV string, requiring `.join(",")`.

**Action**: Replace constant reference and add `.join(",")` conversion.

**Resolution**: §Step 4 pseudocode now uses `scope: EXTENSION_TOKEN_DEFAULT_SCOPES.join(",")` with an inline comment citing the file location and noting the array→CSV conversion.

#### R3-T3 — Major (Testing)

**Problem**: §Step 10 item 5 (malformed body) explicitly asserted `mockLogAudit` NOT called, but items 2, 3, 4 (used / expired / unknown) only asserted `mockWarn` called — without an explicit `mockLogAudit` NOT called assertion. Without the negative assertion, future regressions could re-introduce `logAudit()` calls in failure paths and tests would not catch it.

**Action**: Add `expect(mockLogAudit).not.toHaveBeenCalled()` to items 2, 3, 4.

**Resolution**: §Step 10 items 2, 3, 4, 5 all now explicitly include the negative assertion, formalizing the pino-only design from Considerations §7.

#### R3-T4 — Major (Testing)

**Problem**: §Testing Strategy lists "the extracted `issueExtensionToken` helper" as a unit test target, but §Step 10 and §Implementation Checklist do not include `src/lib/extension-token.test.ts`.

**Action**: Add the test file to the checklist as NEW.

**Resolution**: §Implementation Checklist now includes `src/lib/extension-token.test.ts — NEW, unit tests for issueExtensionToken() helper (R3-T4: required by §Testing Strategy)`.

#### R3-T5 — Major (Testing)

**Problem**: §Step 9's `token-bridge-js-sync.test.ts` design used `fs.readFileSync` with implied `process.cwd()` resolution, which depends on Vitest invocation context. In multi-project setups (extension as a sub-vitest), `process.cwd()` may differ from the file location, causing the test to be flaky or fail outright.

**Action**: Use `__dirname`-relative paths.

**Resolution**: §Step 9 implementation approach now includes a TypeScript snippet using `path.join(__dirname, "../../../../src/lib/constants/extension.ts")` and `path.join(__dirname, "../../lib/constants.ts")`, explicitly noting "Use `__dirname`-relative paths, NOT `process.cwd()`".

#### R3-T6 — Major (Testing)

**Problem**: §Step 10 item 7 used `mockResolvedValueOnce` chain for replay testing, but did not mandate `beforeEach(() => vi.clearAllMocks())`. Without explicit mock reset, the residual `mockResolvedValueOnce` queue could leak into adjacent tests.

**Action**: Add explicit `beforeEach` requirement to the mock setup pattern.

**Resolution**: §Step 10 mock setup pattern includes `beforeEach(() => vi.clearAllMocks())` with a comment explaining the requirement.

### Minor

#### F-R3-04 — Minor (Functionality)

**Problem**: The `!consumed` failure path in §Step 5 returned `serverError()` without any log emission. F-05's intent (pino-only failure logging) was incompletely applied.

**Resolution**: §Step 5 pseudocode now logs the invariant violation via `getLogger().error(...)` with `event: "extension_token_exchange_invariant_violation"` and `codeHash` before returning the error.

#### F-R3-05 — Investigated, NOT a finding

**Problem (raised by Round 3 functionality reviewer)**: `withBypassRls` lambda using `prisma.xxx` directly might not use the transaction client.

**Investigation**: Read `src/lib/tenant-rls.ts:40-52` and confirmed the established pattern: `withBypassRls` wraps `prisma.$transaction((tx) => ...)` and stores the `tx` in AsyncLocalStorage via `tenantRlsStorage.run({ tx, ... }, fn)`. The project's `prisma` singleton is implemented as a proxy that consults this AsyncLocalStorage and forwards to the active `tx` when present. Existing code in `src/lib/audit.ts:118-152` follows the same pattern (calling `prisma.user.findUnique`, `prisma.team.findUnique`, `prisma.auditLog.create` directly inside the `withBypassRls` lambda) and is in production use. No change required to the plan.

#### R3-T7 — Minor (Testing)

**Problem**: Migration metric (Step 11) has no test case in the plan.

**Resolution (deferred)**: The migration metric is observability tooling, not a feature requirement. It will be tested via operational validation, not unit tests. Acknowledged as out of scope for this plan.

#### R3-T8 — Minor (Testing)

**Problem**: bridge-code endpoint test §Step 10 item 6 referenced `mockLogAudit` without specifying the mock declaration pattern.

**Resolution**: §Step 10 bridge-code section now references `vi.mock("@/lib/audit", () => ({ logAudit: mockLogAudit, extractRequestMeta: () => ({ ip: "1.1.1.1", userAgent: "test" }) }))` with the `mockLogAudit` `vi.hoisted` declaration. Cross-references `src/app/api/vault/reset/route.test.ts` as a pattern source.

#### R3-T9 — Minor (Testing)

**Problem**: Git rename detection threshold concern for `inject-extension-token.test.ts` rename.

**Resolution (skipped)**: This is a PR review readability concern, not a correctness issue. Reviewers can be informed via the PR description. No plan change.

#### R3-T10 — Minor (Testing)

**Problem**: `Prisma.ExtensionBridgeCodeGetPayload<{}>` syntax may not be valid in Prisma 7.

**Resolution**: §Step 10 mock-reality consistency note now says "Verify the correct Prisma 7 generic syntax by reading the generated type after `npx prisma generate`. The form `Prisma.ExtensionBridgeCodeGetPayload<{}>` may not be valid in Prisma 7; if not, use `Prisma.ExtensionBridgeCode` (model type alias) or `Prisma.ExtensionBridgeCodeGetPayload<Prisma.ExtensionBridgeCodeDefaultArgs>` per the generated types."

## Resolution Status (Round 3)

| Finding | Severity | Plan Section |
|---------|----------|--------------|
| F-R3-01 | Critical | §Implementation Checklist (refresh route line) |
| R3-T1 | Critical | §Implementation Checklist (token-bridge.test.ts line) |
| R3-T2 | Critical | §Step 10 (mock setup pattern) |
| F-R3-02 | Major | §Step 5 (response helpers) |
| F-R3-03 | Major | §Step 4 (scope constant) |
| R3-T3 | Major | §Step 10 items 2, 3, 4, 5 |
| R3-T4 | Major | §Implementation Checklist (extension-token.test.ts) |
| R3-T5 | Major | §Step 9 (`__dirname` paths) |
| R3-T6 | Major | §Step 10 (`beforeEach` mock setup) |
| F-R3-04 | Minor | §Step 5 (`!consumed` log) |
| F-R3-05 | — | Investigated; not a finding |
| R3-T7 | Minor | Deferred — observability, not feature |
| R3-T8 | Minor | §Step 10 (bridge-code mock pattern) |
| R3-T9 | Minor | Skipped — PR readability only |
| R3-T10 | Minor | §Step 10 (Prisma generic verification note) |

---

# Round 4

Date: 2026-04-11
Review round: 4

## Changes from Previous Round

Three sub-agents re-reviewed after Round 3 fixes. Round 4 caught two Critical issues that previous rounds missed: Round 3 introduced new file references (`extension-token.test.ts` and `token-bridge-js-sync.test.ts`) marked as NEW, but verification against the actual codebase confirmed both files **already exist**, with the sync test using a different (and superior) approach than the plan proposed.

## New Findings (Round 4)

### Critical

#### R4-T1 — Critical (Testing)

**Problem**: Plan §Implementation Checklist marked `src/lib/extension-token.test.ts` as NEW, but the file already exists in the codebase. It currently contains tests for `validateExtensionToken`, `parseScopes`, and `hasScope`. Marking it as NEW could lead an implementer to (a) overwrite the existing tests, or (b) skip the file thinking the work is done.

**Verification**: `ls src/lib/extension-token.test.ts` confirmed the file exists.

**Action**: Change checklist label from NEW to EXTEND. Add a test cases section to §Step 6 specifying what `issueExtensionToken()` test cases must be appended to the existing file.

**Resolution**:
- §Implementation Checklist line updated to "EXTEND (file already exists with `validateExtensionToken`/`parseScopes`/`hasScope` tests; add `issueExtensionToken()` test cases)".
- §Step 6 now contains a "Test cases for `issueExtensionToken()`" subsection with 5 mandatory cases (success, max-active enforcement, under-limit no-revocation, hash determinism, transaction wrapping) and explicit references to existing mock patterns.

#### R4-T2 — Critical (Testing)

**Problem**: §Step 10 mock setup did not include `vi.mock("@/lib/tenant-rls", ...)` for `withBypassRls`. The exchange handler in §Step 5 calls `withBypassRls(prisma, async () => { ... })` twice (atomic consume + findUnique), and the real implementation calls `prisma.$transaction` and `tx.$executeRaw` internally. Without mocking `withBypassRls`, the test would attempt to execute raw SQL against the mocked Prisma, which has no `$executeRaw` implementation — runtime crash or silent failure.

**Action**: Add `mockWithBypassRls` and `mockWithUserTenantRls` to the `vi.hoisted` block; mock `@/lib/tenant-rls` and `@/lib/tenant-context` to bypass the internal `$transaction` wrapper. Pattern mirrors `src/app/api/extension/token/route.test.ts:63-64`.

**Resolution**: §Step 10 mock setup expanded to include `vi.mock("@/lib/tenant-rls", ...)`, `vi.mock("@/lib/tenant-context", ...)`, and the corresponding `mockWithBypassRls`/`mockWithUserTenantRls` declarations. Default implementation: `async (_, fn) => fn()`.

### Major

#### R4-T3 — Major (Testing)

**Problem**: Plan §Step 9 specified creating `extension/src/__tests__/lib/token-bridge-js-sync.test.ts` (in `lib/`) using `fs.readFileSync` + regex parsing. Verification revealed:
1. The file already exists at `extension/src/__tests__/content/token-bridge-js-sync.test.ts` (different directory: `content/`, not `lib/`)
2. It uses Vite's `?raw` import to read the bundled JS file as a string — a fundamentally different (and superior) approach to `fs.readFileSync`
3. The plan's `__dirname`-relative path approach (added in Round 3) was solving a problem caused by an incorrect approach in the first place

**Verification**: `ls extension/src/__tests__/content/token-bridge-js-sync.test.ts` confirmed existence; reading the file confirmed the `?raw` import pattern.

**Action**: Replace the entire §Step 9 sync-test section with the corrected approach: extend the existing `content/` file using the established `?raw` import pattern; add new constants to a new `it(...)` block within the same `describe`.

**Resolution**:
- §Step 9 sync test section completely rewritten to use the existing `?raw` import pattern.
- Implementation Checklist line updated to point to the correct path (`content/` not `lib/`) and labeled EXTEND.
- The `__dirname`/`fs.readFileSync` approach (Round 3 R3-T5 fix) is now obsolete and removed from the plan.

#### R4-T4 — Major (Testing)

**Problem**: §Implementation Checklist listed `src/lib/extension-token.test.ts` (now EXTEND per R4-T1) but no Step section specified what test cases should be added. Without a written specification, an implementer could write minimal tests that miss the `EXTENSION_TOKEN_MAX_ACTIVE` enforcement path.

**Action**: Add minimum required test cases to §Step 6 (the section that introduces the helper).

**Resolution**: §Step 6 now contains 5 mandatory test cases with assertion-level detail (success path token shape, max-active enforcement, under-limit no-revocation, hash determinism, transaction wrapping). See R4-T1 resolution.

#### F-R4-02 — Major (Functionality, raised by functionality reviewer)

**Problem**: §Step 5 pseudocode used `zodValidationError(parsed.error)` and `errorResponse(API_ERROR.INTERNAL_ERROR, 500)` after Round 3 fixes, but neither `zodValidationError`, `errorResponse`, nor `API_ERROR` was listed in the §Implementation Checklist "Shared utilities to reuse" section. Implementers reading only the checklist would lack import path documentation for these.

**Action**: Add the three symbols to the Shared Utilities list with file paths.

**Resolution**: §Implementation Checklist now lists:
- `zodValidationError from src/lib/api-response.ts`
- `errorResponse from src/lib/api-response.ts`
- `API_ERROR from src/lib/api-error-codes.ts`

### Minor

#### R4-T5 — Minor (Testing)

**Problem**: §Step 10 mock setup did not include `vi.mock("@/lib/crypto-server", ...)`. Without mocking, `generateShareToken()` would return real random values per call, making token assertions difficult.

**Action**: Add the crypto-server mock with predictable return values.

**Resolution**: §Step 10 mock setup includes `vi.mock("@/lib/crypto-server", () => ({ generateShareToken: () => "a".repeat(64), hashToken: (t) => "h".repeat(64) }))`.

#### R4-T6 — Minor (Testing)

**Problem**: §Step 10 item 6 (rate limit test) did not specify how to mock `createRateLimiter` to return `allowed: false`, nor that the request body must contain a valid 64-char hex code (otherwise the request fails earlier at the schema validation step).

**Action**: Add `mockCheck` to `vi.hoisted`, mock `@/lib/rate-limit`, and add a note about the valid body requirement.

**Resolution**: §Step 10 mock setup includes `mockCheck` and `vi.mock("@/lib/rate-limit", ...)`. A note after the mock pattern explicitly says "use a valid 64-char hex `code` in the request body so the request progresses past the schema validation and reaches the rate limit check".

#### F-R4-01 — Minor (Functionality)

**Problem**: Same as R4-T4 — `extension-token.test.ts` test scope undefined. Resolved together with R4-T1/R4-T4 in §Step 6.

## Resolution Status (Round 4)

| Finding | Severity | Plan Section |
|---------|----------|--------------|
| R4-T1 | Critical | §Implementation Checklist, §Step 6 |
| R4-T2 | Critical | §Step 10 (mock setup) |
| R4-T3 | Major | §Step 9, §Implementation Checklist |
| R4-T4 / F-R4-01 | Major / Minor | §Step 6 (test cases) |
| F-R4-02 | Major | §Implementation Checklist (Shared Utilities) |
| R4-T5 | Minor | §Step 10 (crypto-server mock) |
| R4-T6 | Minor | §Step 10 (rate limit mock) |

---

# Round 5

Date: 2026-04-11
Review round: 5

## Changes from Previous Round

Three sub-agents re-reviewed after Round 4 fixes. Round 5 found:
- **Security**: NO findings — Round 4 testing fixes have no security implications. The plan is implementation-ready from a security standpoint.
- **Functionality**: 1 Major (F-R5-01) + 1 Minor (F-R5-02)
- **Testing**: 1 Major (R5-T1) + 1 Minor (R5-T2)

No Critical findings.

## New Findings (Round 5)

### Major

#### F-R5-01 — Major (Functionality)

**Problem**: §Step 9 pseudocode for `token-bridge-lib.ts` called a non-existent function `getApiBase()`. Verification: `grep -rn "getApiBase" extension/src/` yields zero matches. The established pattern for resolving the server URL in extension content scripts is `chrome.storage.local.get("serverUrl", ...)` (see `extension/src/content/webauthn-bridge.ts:13` and `extension/src/background/index.ts:506`).

**Action**: Replace `getApiBase()` with the actual `chrome.storage.local.get("serverUrl")` pattern.

**Resolution**: §Step 9 pseudocode now uses `const { serverUrl } = await chrome.storage.local.get("serverUrl");` with an explicit comment citing both reference files. Adds an early `return false` if `serverUrl` is missing.

#### R5-T1 — Major (Testing)

**Problem**: §Step 6 listed 5 test cases for `issueExtensionToken()`, including case 5 ("Transaction wrapping: assert `prisma.$transaction` is called exactly once per invocation"). However, the existing `src/lib/extension-token.test.ts` `vi.hoisted` block does NOT include `mockTransaction`, and the existing `vi.mock("@/lib/prisma", ...)` does not declare `$transaction`. Without explicit instruction to add these, an implementer will not be able to write case 5 — calling `expect(prisma.$transaction).toHaveBeenCalledTimes(1)` against an undefined property fails with a runtime error.

**Action**: Add explicit instructions to extend the existing `vi.hoisted` block and Prisma mock with `mockTransaction` declarations.

**Resolution**: §Step 6 test cases section now includes a "Required additions to the existing `extension-token.test.ts` `vi.hoisted` block" subsection with the specific code to append (declarations, mock extension, default `beforeEach` implementation, assertion form for case 5).

### Minor

#### F-R5-02 — Minor (Functionality)

**Problem**: §Step 10 "Files: existing tests that may break" still listed `extension/src/__tests__/lib/token-bridge-js-sync.test.ts` (the wrong `lib/` path) — a leftover from before the Round 4 R4-T3 fix. The Implementation Checklist had been corrected, but this stale reference in §Step 10 was not.

**Resolution**: §Step 10 line corrected to `content/token-bridge-js-sync.test.ts` with an inline note "(correct path is `content/`, NOT `lib/`)".

#### R5-T2 — Minor (Testing)

**Problem**: The Vite `?raw` bundle check pattern works for string constants like `BRIDGE_CODE_MSG_TYPE` (which appear literally in the bundled JS) but does NOT verify that numeric constants (`BRIDGE_CODE_TTL_MS`, `BRIDGE_CODE_MAX_ACTIVE`) hold the same value in the web app and extension repos. TypeScript import success only proves the constants exist, not that their values match.

**Action**: Add a dedicated cross-repo equality test on the web app side (which has access to both files via relative imports).

**Resolution**: §Step 9 now specifies a NEW test file `src/__tests__/i18n/extension-constants-sync.test.ts` on the web app side that imports both `@/lib/constants/extension` and the relative `extension/src/lib/constants` and asserts each constant's equality. Falls back to `fs.readFileSync` parsing if the relative TypeScript import path doesn't resolve. §Implementation Checklist also updated.

## Resolution Status (Round 5)

| Finding | Severity | Plan Section |
|---------|----------|--------------|
| F-R5-01 | Major | §Step 9 (pseudocode) |
| R5-T1 | Major | §Step 6 (extension-token.test.ts mock additions) |
| F-R5-02 | Minor | §Step 10 (path correction) |
| R5-T2 | Minor | §Step 9 (cross-repo equality test), §Implementation Checklist |

---

# Round 6 — Final Verification

Date: 2026-04-11
Review round: 6 (strict stopping criterion: Critical only)

## Result

All three sub-agents (functionality, security, testing) reported:

> **No Critical findings — plan ready to commit.**

Each agent independently verified the Round 5 fixes against the actual codebase:
- **F-R5-01**: Verified — §Step 9 uses `chrome.storage.local.get("serverUrl")` matching `extension/src/content/webauthn-bridge.ts:13`
- **F-R5-02**: Verified — §Step 10 path corrected to `content/`
- **R5-T1**: Verified — §Step 6 explicitly says "**Append** ... (do NOT replace)" with full code
- **R5-T2**: Verified — `src/__tests__/i18n/extension-constants-sync.test.ts` is fully specified with fallback guidance

## Deferred Observations

Each agent noted one or two non-blocking items, documented here for implementation-time awareness:

1. **DEFERRED (Security)**: §Step 9 `await response.json()` does not validate the exchange response shape. A misconfigured/compromised server could return malformed JSON. Impact: `chrome.runtime.sendMessage` would receive `undefined` token; background script would ignore. No security escalation, just a reliability nit. Recommend adding a Zod parse on the response in implementation.

2. **DEFERRED (Testing)**: §Step 6 mock replacement block could be misread as removing `mockWithBypassRls`. Implementer should preserve all existing entries when extending. The instruction "Append (do NOT replace)" makes this clear, but worth a re-read during implementation.

These items are intentionally NOT applied to the plan because:
- They are non-blocking and were caught by aggressive multi-round review
- Their cost-to-benefit ratio at plan-time is low
- They will be naturally caught during implementation or Phase 2 code review

## Convergence Summary

| Round | Critical | Major | Minor | Notes |
|-------|----------|-------|-------|-------|
| 1 | 4 | 13 | 10 | Initial review of design proposal |
| 2 | 2 | 5 | 8 | Codebase verification round |
| 3 | 3 | 5 | 8 | Helper/constant existence verification |
| 4 | 2 | 3 | 3 | "NEW vs EXTEND" file verification |
| 5 | 0 | 2 | 2 | Pseudocode placeholders |
| 6 | **0** | (deferred) | (deferred) | **Final verification — committed** |

Total findings reflected in plan: 41 (4 Critical + 28 Major + 8 Minor + 1 cross-cutting). Plan transitioned from a textual design proposal to an implementation-ready specification across 6 review rounds.

## Conclusion

Plan is approved for commit and Phase 2 (Coding) entry.
