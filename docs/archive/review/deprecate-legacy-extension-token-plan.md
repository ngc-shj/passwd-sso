# Plan: Deprecate Legacy Extension Token Issuance Endpoint

Date: 2026-05-24
Author: triangulate workflow
Severity addressed: **P0 (security review)**
Revision: Round 1 review applied — scope expanded per F1.

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + PostgreSQL 16)
- **Test infrastructure**: unit (Vitest) + integration (real-DB Vitest) + E2E (Playwright) + CI/CD (GitHub Actions)
- **Deployment**: Docker Compose (app / db / jackson / redis / migrate / audit-outbox-worker)

## Objective

Eliminate `POST /api/extension/token` (the legacy direct-issuance endpoint) and **every UI surface that calls it** as a same-origin XSS attack surface. After this change:

- The only path to obtain a browser-extension bearer token is the bridge-code exchange flow (`POST /api/extension/bridge-code` → `postMessage` → `POST /api/extension/token/exchange`).
- The only path to obtain a CLI bearer token is the OAuth 2.1 PKCE / DCR flow (`passwd-sso login` without `--token`), as already documented in `CLAUDE.md` "Machine Identity" §"CLI OAuth login".
- The `POST /api/extension/token` endpoint always responds 410 Gone with an audit row and `Deprecation: true` header.
- `DELETE /api/extension/token` (revoke) is **unchanged**.

## Why now

- **Threat model**: with the legacy endpoint live, any same-origin XSS can either (a) fetch `POST /api/extension/token` directly with the session cookie, or (b) click the "Generate" button on `CliTokenCard` to trigger the same fetch. Both paths exfiltrate a bearer token in plaintext. Browser-extension tokens are NOT sender-constrained for `BROWSER_EXTENSION` rows.
- **Replacement is production-ready**: the bridge-code flow has been live since the `harden-extension-token-bridge` plan ([docs/archive/review/harden-extension-token-bridge-plan.md](./harden-extension-token-bridge-plan.md)). The CLI OAuth PKCE/DCR flow is documented as the **primary** CLI auth path in CLAUDE.md.
- **Extension client migrated**: extension v0.4.51+ calls `POST /api/extension/token/exchange` exclusively ([extension/src/content/token-bridge.js:56-73](../../../extension/src/content/token-bridge.js)).
- **CliTokenCard is a manual `--token` paste fallback**: per CLAUDE.md, the canonical CLI sign-in is `passwd-sso login` (OAuth PKCE). The `--token` manual paste mode is a legacy convenience that this PR removes.

## Requirements

### Functional

- `POST /api/extension/token` returns HTTP 410 Gone for every caller, regardless of session state, with `Deprecation: true` header.
- `DELETE /api/extension/token` (revoke) is unchanged.
- Authenticated calls to the 410 path: one audit row per call, capped by rate limiter.
- Unauthenticated calls: one audit row per call (using `ANONYMOUS_ACTOR_ID` + `ACTOR_TYPE.ANONYMOUS`), capped by rate limiter; falls back to `logger.warn` if `logAuditAsync` dead-letters.
- `CliTokenCard` component, its page route, its test, its sidebar link, its i18n namespace, and its E2E page-object method are **deleted**. CLI users follow the OAuth PKCE flow.
- Bridge-code flow and refresh flow continue to work unmodified.

### Non-functional

- **No env flag.** The endpoint behaves identically in all environments. Rollback is `git revert` + redeploy.
- **No code deletion of `handlePOST` in this PR.** Handler is reduced to "rate-limit → audit emit → 410". Full handler deletion is a follow-up after one Minor release cycle of zero-traffic confirmation. `handleDELETE` is byte-identical.
- The migration metric `event: "extension_token_legacy_issuance"` (info-level) is replaced by `event: "extension_token_legacy_issuance_blocked"` (warn-level).

## Technical approach

The change touches the following files. The matrix is split by domain:

### Backend route + supporting constants

| # | File | Edit |
|---|------|------|
| 1 | [src/lib/http/api-error-codes.ts](../../../src/lib/http/api-error-codes.ts) | Add `EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED` to **3 maps**: `API_ERROR` (string→string), `API_ERROR_STATUS` (→ `410`), `API_ERROR_I18N` (→ `"extensionTokenLegacyIssuanceDeprecated"`). |
| 2 | [messages/en/ApiErrors.json](../../../messages/en/ApiErrors.json) | Add `"extensionTokenLegacyIssuanceDeprecated": "This endpoint has been retired. Update the extension, or use 'passwd-sso login' for CLI access."` |
| 3 | [messages/ja/ApiErrors.json](../../../messages/ja/ApiErrors.json) | Add `"extensionTokenLegacyIssuanceDeprecated": "このエンドポイントは廃止されました。拡張機能の更新、または CLI は 'passwd-sso login' をご利用ください。"` |
| 4 | [prisma/schema.prisma](../../../prisma/schema.prisma) (line ~865) | Append `EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` to the `enum AuditAction { ... }` block. |
| 5 | `prisma/migrations/<timestamp>_add_extension_token_legacy_issuance_blocked_audit_action/migration.sql` (new file) | `ALTER TYPE "AuditAction" ADD VALUE 'EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED';` — Slug follows the established `add_<action_name>_audit_action` convention (verified precedents: `20260418143000_add_extension_token_family_revoked_audit_action`, `20260307055426_add_vault_setup_audit_action`, 8+ others). PostgreSQL forbids `ALTER TYPE ... ADD VALUE` inside a transaction; Prisma generates this migration as a single non-transactional statement. |
| 6 | [src/lib/constants/audit/audit.ts](../../../src/lib/constants/audit/audit.ts) | **3 insertion points**: (a) `AUDIT_ACTION` const-object (line ~169-171 alongside `EXTENSION_TOKEN_EXCHANGE_*`), (b) the flat `AUDIT_ACTION_VALUES` array (line ~356 alongside `EXTENSION_TOKEN_EXCHANGE_FAILURE`), (c) `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.AUTH]` (line ~434-437 alongside `EXTENSION_TOKEN_EXCHANGE_*`). |
| 7 | [messages/en/AuditLog.json](../../../messages/en/AuditLog.json) | Add `"EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED": "Blocked legacy extension token issuance attempt"` adjacent to lines 235-236. |
| 8 | [messages/ja/AuditLog.json](../../../messages/ja/AuditLog.json) | Add `"EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED": "拡張機能の旧トークン発行 API 呼び出しをブロック"`. |
| 9 | [src/app/api/extension/token/route.ts](../../../src/app/api/extension/token/route.ts) | Replace `handlePOST` body per C1 (IP rate-limit → emit ANONYMOUS audit → return 410 with `Deprecation: true` header). `handleDELETE` unchanged. Remove unused imports (`auth`, `requireRecentSession`, `issueExtensionToken`, `EXTENSION_TOKEN_DEFAULT_SCOPES`, `withUserTenantRls`, `TokenIssueResponseSchema`). |
| 10 | [src/app/api/extension/token/route.test.ts](../../../src/app/api/extension/token/route.test.ts) | Per C4: delete 5 existing POST tests; add 5 new POST tests; add `vi.mock("@/lib/audit/audit", ...)` (pattern: `exchange/route.test.ts:71-76`); strip stale POST-only mock setup from `beforeEach`. DELETE tests unchanged. |

### Frontend deletions (CliTokenCard sweep)

| # | File | Edit |
|---|------|------|
| 11 | [src/components/settings/developer/cli-token-card.tsx](../../../src/components/settings/developer/cli-token-card.tsx) | **Delete file**. |
| 12 | [src/components/settings/developer/cli-token-card.test.tsx](../../../src/components/settings/developer/cli-token-card.test.tsx) | **Delete file**. |
| 13 | [src/app/[locale]/dashboard/settings/developer/cli-token/page.tsx](../../../src/app/%5Blocale%5D/dashboard/settings/developer/cli-token/page.tsx) | **Delete file**. |
| 14 | [src/app/[locale]/dashboard/settings/layout.tsx](../../../src/app/%5Blocale%5D/dashboard/settings/layout.tsx) line 72 | **Remove sidebar link** to `/dashboard/settings/developer/cli-token` (one line). Verified via Round 2 codebase scan: the "Developer" parent section retains 2 siblings (`api-keys`, `mcp-connections`), so the parent header stays unchanged. Do NOT touch the parent. |
| 14b | [messages/en/Settings.json](../../../messages/en/Settings.json), [messages/ja/Settings.json](../../../messages/ja/Settings.json) | **Remove the `subTab.cliToken` key** from both files. The key is consumed by the layout line being deleted in #14; leaving it produces a dead translation entry. |
| 15 | [src/i18n/namespace-groups.ts:60](../../../src/i18n/namespace-groups.ts#L60) | **Remove** `"CliToken",`. |
| 16 | [src/i18n/messages.ts:60](../../../src/i18n/messages.ts#L60) | **Remove** `"CliToken",`. |
| 17 | [messages/en/CliToken.json](../../../messages/en/CliToken.json) | **Delete file**. |
| 18 | [messages/ja/CliToken.json](../../../messages/ja/CliToken.json) | **Delete file**. |
| 19 | [e2e/page-objects/settings.page.ts:28-29](../../../e2e/page-objects/settings.page.ts#L28-L29) | **Remove** `gotoCliToken()` method. (Confirmed no E2E spec calls it — dead code.) |
| 20 | [src/components/settings/developer/](../../../src/components/settings/developer/) | If empty after #11, #12 deletions, **delete the directory**. |

**Total**: 22 file operations (11 backend + 11 frontend; updated post-Round 2 to include `subTab.cliToken` cleanup in `messages/{en,ja}/Settings.json`). No new dependencies. One Prisma enum migration.

## Contracts

### C1 — `POST /api/extension/token` always returns 410 Gone (rate-limited, audited)

- **Signature** (Phase 2 must conform):
  ```ts
  async function handlePOST(req: NextRequest): Promise<NextResponse>
  ```
  Body shape:
  ```ts
  // 1. IP-keyed rate limit (per C7)
  const ip = extractClientIp(req);
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: legacyDeprecatedLimiter,
    key: rateLimitKeyFromIp(ip, "ext_token_deprecated"),
    scope: "extension.token_legacy_blocked",
    userId: null,
  });
  if (blocked) return blocked;

  // 2. Anonymous audit emission (per C6) — fire-and-forget
  await logAuditAsync({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED,
    userId: ANONYMOUS_ACTOR_ID,
    actorType: ACTOR_TYPE.ANONYMOUS,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  // 3. Structured warn-level log for ops dashboards (replaces the legacy info-level metric)
  logger.warn(
    { event: "extension_token_legacy_issuance_blocked", ip },
    "legacy extension token issuance attempted — endpoint is gone",
  );

  // 4. 410 response with Deprecation header per RFC 9745
  return errorResponse(
    API_ERROR.EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED,
    undefined,
    undefined,
    { Deprecation: "true" },
  );
  ```

- **Invariants**:
  - `issueExtensionToken` is **never** called from this route handler.
  - `auth()` and `requireRecentSession()` are **not** invoked.
  - `withUserTenantRls` is **not** invoked.
  - The `Deprecation: true` response header is present.
  - Every invocation that passes the rate limit produces exactly one audit log row with `action = AUDIT_ACTION.EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` and `userId = ANONYMOUS_ACTOR_ID`. (Note: for callers that hit the rate limit, the 429 response from `checkRateLimitOrFail` writes its own `RATE_LIMIT_EXCEEDED` audit per existing infrastructure — no double-audit.)
  - `handleDELETE` and its export are byte-identical to the pre-change version.

- **Forbidden patterns** (grep across `src/app/api/extension/token/route.ts` POST handler scope):
  - `pattern: issueExtensionToken\s*\(` — reason: legacy issuance unreachable.
  - `pattern: requireRecentSession\s*\(` — reason: no session-age dependency.
  - Inside `handlePOST` body: no `auth\s*\(\s*\)`, no `withUserTenantRls\s*\(` — reason: no identity resolution.

- **Acceptance criteria**:
  - `curl -X POST /api/extension/token` (any auth combination, under rate limit) → 410 + body `{ "error": "EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED" }` + header `Deprecation: true`.
  - `audit_outbox` receives one row per accepted call with `action = EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED`, `userId = ANONYMOUS_ACTOR_ID`, `actorType = ANONYMOUS`.
  - Over-rate calls receive 429 (existing rate-limit behavior).

- **Consumer-flow walkthrough**:
  - **Consumer 1**: Browser extension v0.4.51+ — does not call this endpoint. Unaffected.
  - **Consumer 2**: Browser extension < v0.4.51 (if any deployed) — receives 410. UX degraded to "must update" until Chrome Web Store auto-update.
  - **Consumer 3**: `CliTokenCard` UI — **deleted** in this PR (no longer a consumer).
  - **Consumer 4**: External / third-party scripts (none known; grep-confirmed) — receive 410.
  - **Consumer 5**: Route test (per C4) — asserts 410, header, audit emission.
  - **Consumer 6**: Operations dashboards — primary observability is the **`logger.warn` line `event=extension_token_legacy_issuance_blocked`** (warn level) in app stdout. The audit-log filter `action = EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` is secondary; per C6, rows route to dead-letter for unauthenticated callers (no tenantId resolvable). Expected post-deploy count on both: zero.
  - **Consumer 7**: Proxy CSRF gate — unaffected; gate fires on cookie+mutating-method regardless of handler logic.

### C2 — `AUDIT_ACTION.EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` registered everywhere R12 requires

- **Signature**:
  ```ts
  // In src/lib/constants/audit/audit.ts
  export const AUDIT_ACTION = {
    ...,
    EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED: "EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED",
  } as const satisfies Record<AuditAction, AuditAction>;
  ```
  The `satisfies Record<AuditAction, AuditAction>` constraint is what forces C5 (Prisma enum addition) — without it, TypeScript fails to compile.

- **Invariants**:
  - The string literal value equals the key (consistent with existing entries).
  - The action appears in each of the 3 insertion points (file matrix #6 a/b/c).
  - The action appears in both `messages/{en,ja}/AuditLog.json`.

- **Forbidden patterns**: none.

- **Acceptance criteria**:
  - `npm run lint` passes.
  - `npx vitest run` passes — particularly the exhaustiveness tests at `src/lib/constants/audit/audit.test.ts:71-77` (action-value alignment) and `:213-221` (scope-group membership: every action belongs to PERSONAL ∪ TEAM ∪ TENANT).
  - `npx next build` passes.

- **Consumer-flow walkthrough** (concretized; not deferred):
  - **Consumer 1**: [src/lib/constants/audit/audit.ts](../../../src/lib/constants/audit/audit.ts) — 3 insertion points enumerated in file matrix #6. PERSONAL.AUTH placement satisfies the scope-group exhaustiveness check.
  - **Consumer 2**: [messages/en/AuditLog.json](../../../messages/en/AuditLog.json), [messages/ja/AuditLog.json](../../../messages/ja/AuditLog.json) — both required for i18n coverage tests.
  - **Consumer 3**: [src/lib/constants/audit/audit.test.ts](../../../src/lib/constants/audit/audit.test.ts:71-77, :213-221) — exhaustiveness tests pass mechanically when consumers 1-2 are satisfied.

  **NOT in scope** (verified by grep, none exist):
  - No separate UI label map for audit actions (filter dropdown reads from `messages/{locale}/AuditLog.json` directly).
  - No exhaustive `switch (action)` in application code.
  - No OpenAPI spec entry (`/api/extension/token` is not in `/api/v1/*`; `grep -n 'extension/token' src/lib/openapi-spec.ts` returns 0 matches).
  - No audit CSV/JSONL export that hardcodes the action name (download routes serialize from DB rows).

### C3 — `API_ERROR.EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED` registered across 3 maps + i18n

- **Signature** (matches actual codebase shape verified via [src/lib/http/api-error-codes.ts:280, :500-507](../../../src/lib/http/api-error-codes.ts)):
  ```ts
  // 1. API_ERROR (string→string identity map, around line ~150-230)
  export const API_ERROR = {
    ...,
    EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED: "EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED",
  } as const;

  // 2. API_ERROR_STATUS (→ HTTP status, line 280-500)
  export const API_ERROR_STATUS = {
    ...,
    EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED: 410,
  } as const satisfies Record<ApiErrorCode, number>;

  // 3. API_ERROR_I18N (→ i18n key, line 507+)
  const API_ERROR_I18N: Record<ApiErrorCode, string> = {
    ...,
    EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED: "extensionTokenLegacyIssuanceDeprecated",
  };

  // 4. messages/{en,ja}/ApiErrors.json
  { ..., "extensionTokenLegacyIssuanceDeprecated": "<text>" }
  ```

- **Invariants**:
  - HTTP status code = 410 (matches `SHARE_GONE`, `VAULT_RESET_TOKEN_EXPIRED` precedent).
  - i18n key uses camelCase (matches existing convention).
  - All 3 maps + 2 JSON files are updated atomically — `satisfies Record<ApiErrorCode, ...>` would fail to compile otherwise.

- **Forbidden patterns**: none.

- **Acceptance criteria**:
  - `errorResponse(API_ERROR.EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED, undefined, undefined, { Deprecation: "true" })` returns 410 with envelope `{ "error": "EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED" }` and header `Deprecation: true`.

- **Consumer-flow walkthrough**:
  - **Consumer 1**: `handlePOST` reads the entry in `errorResponse(...)`.
  - **Consumer 2**: Route test asserts `JSON.parse(body).error === "EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED"`.
  - **Consumer 3**: i18n error display (any UI that renders ApiErrors translations) — reads `extensionTokenLegacyIssuanceDeprecated` key when an unauthenticated SDK / client surfaces it.

### C4 — Route test asserts 410 + audit emission + header (5 explicit POST tests)

- **Signature**: existing test file `src/app/api/extension/token/route.test.ts` updated. No new test files.

- **Invariants**:
  - **Delete** the 5 existing POST tests:
    1. `returns 401 when not authenticated`
    2. `returns 429 when rate limited` (existing user-keyed limiter)
    3. `returns 403 when session step-up required`
    4. `issues a token successfully`
    5. `revokes oldest token when MAX_ACTIVE exceeded`
  - **Add** the 4 new POST tests (test #3 from Round 1 was dropped in Round 2 — forbidden-pattern grep in C1 already enforces zero calls to `auth()` / `requireRecentSession()` / `issueExtensionToken()`; an extra spy test would require additional unused mocks for `@/lib/auth/tokens/extension-token` (T9)):
    1. `returns 410 with no session cookie` — assert status 410, body `{ error: "EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED" }`.
    2. `returns 410 even with valid session cookie` — same assertions; covers the C1 invariant "regardless of session state".
    3. `emits ANONYMOUS_ACTOR_ID audit row with EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` — `expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTION.EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED, userId: ANONYMOUS_ACTOR_ID, actorType: ACTOR_TYPE.ANONYMOUS }))`.
    4. `response includes Deprecation: true header` — `expect(res.headers.get("Deprecation")).toBe("true")`.
    5. `returns 429 when IP rate limit exceeded` — exhaust the limiter mock to verify rate-limit path (covers C7 acceptance criterion).
  - **Add** the following vi.mock blocks to the hoisted mocks (pattern reference: [src/app/api/extension/token/exchange/route.test.ts:71-91](../../../src/app/api/extension/token/exchange/route.test.ts#L71-L91)):
    ```ts
    vi.mock("@/lib/audit/audit", () => ({
      logAuditAsync: mockLogAudit,
      // NOTE: do NOT copy `personalAuditBase` from exchange/route.test.ts —
      // C6 inlines the audit fields directly, the helper is not used here.
    }));
    vi.mock("@/lib/auth/policy/ip-access", () => ({
      extractClientIp: mockExtractClientIp,
      rateLimitKeyFromIp: (ip: string) => `ip:${ip}`,  // stub to a stable string
    }));
    vi.mock("@/lib/security/rate-limit-audit", () => ({
      checkIpRateLimit: mockCheckIpRateLimit,
      checkRateLimitOrFail: mockCheckRateLimit,
    }));
    vi.mock("@/lib/logger", () => ({
      default: { warn: mockWarn },
    }));
    ```
  - **Remove** the following POST-only mock state. Symbol names verified against the actual file (NOT the `mockExtensionToken*`-style names; the file uses bare `mockCreate` / `mockFindMany` / etc.):
    - `mockAuth` (no longer needed — handler doesn't call `auth()`)
    - `mockRequireRecentSession` (no longer called)
    - `mockUserFindUnique` (was POST-scope only)
    - `mockTransaction`, `mockCreate`, `mockUpdateMany`, `mockFindMany` (POST-scope issuance state machine — entirely dead after C1)
    - `mockWithUserTenantRls` (POST scope only — DELETE uses `mockWithBypassRls`)
    - The `vi.mock("@/auth", ...)`, `vi.mock("@/lib/auth/session/step-up", ...)`, `vi.mock("@/lib/tenant-context", ...)` blocks (entirely unused after the symbols above are dropped).
  - **Keep** mocks needed by DELETE tests (unchanged):
    - `mockFindUnique`, `mockUpdate` (DELETE-scope `extensionToken.findUnique` + `extensionToken.update`)
    - `mockEnforceAccessRestriction` (DELETE-scope policy check)
    - `mockWithBypassRls`, `mockHashToken` (DELETE-scope helpers)
  - All DELETE tests are byte-identical.

- **Forbidden patterns** (grep on `route.test.ts` after edit):
  - `pattern: status:\s*201` in POST tests — reason: 201 success path is gone.
  - `pattern: ["']EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED["']` — reason: import `API_ERROR.EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED` from `@/lib/http/api-error-codes` instead (per RT3).
  - `pattern: ["']EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED["']` — reason: import `AUDIT_ACTION.EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` from `@/lib/constants` instead.

- **Acceptance criteria**:
  - `npx vitest run src/app/api/extension/token/route.test.ts` passes.
  - All 5 new POST tests appear in the file; all 5 old POST tests are gone (grep confirms).

### C5 — Prisma `AuditAction` enum migration

- **Signature**:
  ```prisma
  // prisma/schema.prisma, in enum AuditAction { ... } (line ~865-1020)
  enum AuditAction {
    ...
    EXTENSION_TOKEN_EXCHANGE_SUCCESS
    EXTENSION_TOKEN_EXCHANGE_FAILURE
    EXTENSION_TOKEN_FAMILY_REVOKED
    EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED  // new
    ...
  }
  ```
  ```sql
  -- prisma/migrations/<timestamp>_audit_action_legacy_extension_token_blocked/migration.sql
  ALTER TYPE "AuditAction" ADD VALUE 'EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED';
  ```

- **Invariants**:
  - Prisma migration runs OUTSIDE a transaction (PostgreSQL forbids `ALTER TYPE ... ADD VALUE` inside a tx). Prisma generates this correctly by default for enum value additions — verify by inspecting the generated migration file before commit.
  - The new enum value is appended (not inserted) so existing audit_logs row ordering / numeric position is stable.
  - Migration name uses repository convention (search `prisma/migrations/` for existing `*audit_action*` migrations and match the slug style).

- **Forbidden patterns**:
  - `pattern: BEGIN;` in the new migration file — reason: ALTER TYPE must not be wrapped in a transaction.

- **Acceptance criteria**:
  - `npm run db:migrate` (Prisma dev) succeeds on the dev DB.
  - Subsequent `INSERT INTO audit_logs (..., action) VALUES (..., 'EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED')` succeeds.
  - `npx prisma generate` regenerates `AuditAction` type to include the new value, unblocking C2's `satisfies Record<AuditAction, AuditAction>` constraint.

### C6 — Anonymous audit emission (no new helper)

- **Decision**: use existing `logAuditAsync()` directly with sentinel actor identity. Do NOT introduce a new wrapper.

- **Rationale**:
  - `ANONYMOUS_ACTOR_ID` + `ACTOR_TYPE.ANONYMOUS` is the established pattern (precedent: [src/lib/auth/policy/access-restriction.ts:182](../../../src/lib/auth/policy/access-restriction.ts#L182) — `actorType: userId ? ACTOR_TYPE.HUMAN : ACTOR_TYPE.ANONYMOUS`).
  - `AuditLogParams.userId` is non-nullable `string`; the documented escape for anonymous is the sentinel UUID `ANONYMOUS_ACTOR_ID` (`src/lib/constants/app.ts:61`).
  - Adding a new `anonymousAuditBase()` helper for one site is R1 (helper reimplementation) in reverse — premature abstraction.

- **Tenant resolution behaviour**: `logAuditAsync` calls `resolveTenantId(params)`. With `tenantId` omitted, no `userId` to resolve from, no `teamId`, the resolver returns `null` → the row goes to **dead-letter logger** (not `audit_outbox`).

- **Mitigation for dead-letter routing**: the `logger.warn({ event: "extension_token_legacy_issuance_blocked", ip })` line in C1 is the primary observability surface. The audit row is best-effort. Acknowledged in §5 risk register.

- **Acceptance criteria**:
  - Mock spy `mockLogAudit` is called with exactly `{ scope: "PERSONAL", action: "EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED", userId: ANONYMOUS_ACTOR_ID, actorType: "ANONYMOUS", ip: <ip>, userAgent: <ua> }`.

### C7 — IP-keyed rate limiter on the 410 path

- **Signature** (matches `extension/token/exchange/route.ts:78-91` pattern exactly — `checkIpRateLimit` + `checkRateLimitOrFail` two-step composition):
  ```ts
  // Module-level limiter (replaces the existing user-keyed `tokenLimiter`)
  const legacyDeprecatedLimiter = createRateLimiter({
    windowMs: 15 * MS_PER_MINUTE,
    max: 10,
    failClosedOnRedisError: true,
  });

  // In handlePOST:
  const ip = extractClientIp(req);
  const rl = await checkIpRateLimit({
    ip,
    pathname: req.nextUrl.pathname,
    scope: "ext_token_legacy_blocked",
    limiter: legacyDeprecatedLimiter,
  });
  const blocked = await checkRateLimitOrFail({
    req,
    result: rl,
    scope: "extension.token_legacy_blocked",
    userId: null,
  });
  if (blocked) return blocked;
  ```
  The two-step form: `checkIpRateLimit` owns IPv6 /64 normalization via internal `rateLimitKeyFromIp` (signature is 1-arg, NOT 2-arg). Without this, an IPv6 attacker behind a /56 prefix can rotate the low bits to multiply the per-IP budget.

- **Rationale (S1)**: without a rate limiter, the 410 path writes one audit row per request. An attacker (authenticated or not) can flood `audit_outbox` / dead-letter log. IP-keyed limiter bounds abuse without requiring `auth()`.

- **Invariants**:
  - `checkRateLimitOrFail` returns the existing 429 envelope (`rateLimited(retryAfterMs)`) when over-cap.
  - On 503 (redisErrored): the existing `emitRateLimitFailClosed` infrastructure handles audit emission internally (pre-auth path → warn log only, since no tenantId resolvable).
  - `userId: null` is the documented signature for IP-only callers (matches `exchange/route.ts` precedent).
  - Limit is intentionally `10/15min/IP` — tight, since legitimate traffic should be zero.

- **Acceptance criteria**:
  - 11th call from same IP within 15 min returns 429 (existing `rateLimited()` envelope with `Retry-After` header).
  - Audit row is NOT emitted for rate-limited 429 calls (verified: `checkRateLimitOrFail` only emits audit on the 503 branch via `emitRateLimitFailClosed`, NOT on the 429 branch — see `src/lib/security/rate-limit-audit.ts:238-258`).
  - **429 observability is via the limiter's internal `pre_auth_skip` warn log** (`emitRateLimitFailClosed` falls back to `getLogger().warn(..., "rate-limit.fail_closed.pre_auth_skip")` when `tenantId` is null), NOT via `audit_outbox`. Operators searching for surprise traffic must consult both `extension_token_legacy_issuance_blocked` (410 path) and `rate-limit.fail_closed.pre_auth_skip` (429 path on Redis-error only). Scenario E reflects this.

## Go/No-Go Gate

| ID  | Subject                                                                          | Status |
|-----|----------------------------------------------------------------------------------|--------|
| C1  | `POST /api/extension/token` always returns 410 + audit + Deprecation header      | pending |
| C2  | `AUDIT_ACTION.EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` registered (R12 coverage) | pending |
| C3  | `API_ERROR.EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED` (3 maps + 2 i18n files)   | pending |
| C4  | Route test: 5 new POST tests + audit mock + Deprecation header assertion         | pending |
| C5  | Prisma `AuditAction` enum migration (non-transactional `ALTER TYPE`)              | pending |
| C6  | Anonymous audit emission via existing `logAuditAsync` + sentinel actor identity   | pending |
| C7  | IP-keyed rate limiter on the 410 path                                             | pending |
| C8  | CliTokenCard frontend sweep (10 file operations per matrix #11-20)                | pending |

All 8 flip to `locked` only after Phase 1 review rounds close with no Critical or Major findings.

### C8 — CliTokenCard sweep (defined here for Go/No-Go reference)

- **Scope**: file matrix #11-20.
- **Invariants**:
  - No remaining grep match for `CliTokenCard|cli-token-card|"CliToken"` across `src/`, `messages/`, `e2e/`, `docs/` (excluding plan history).
  - Dashboard sidebar (`/dashboard/settings/layout.tsx`) renders correctly without the link.
  - The "Developer" parent section: verify whether it contains other sub-tabs. If empty, remove the section entirely; if it has siblings (e.g., API Keys), keep the parent.
- **Forbidden patterns** (post-edit grep on the full repo):
  - `pattern: CliTokenCard` — reason: component is deleted.
  - `pattern: /dashboard/settings/developer/cli-token` — reason: page is deleted.
- **Acceptance criteria**:
  - `npx vitest run` passes (no test references the deleted component).
  - `npx next build` passes (no import error).
  - `messages/{en,ja}/CliToken.json` files are removed from disk.
  - `src/i18n/namespace-groups.ts` and `src/i18n/messages.ts` do not list `"CliToken"`.

## Testing strategy

- **Unit / route tests**: `route.test.ts` per C4 (5 new POST tests, 5 deleted POST tests, audit mock added). `cli-token-card.test.tsx` deleted (C8).
- **Integration tests**: existing `extension/token/exchange` and `extension/token/refresh` integration tests must continue to pass — unaffected.
- **E2E tests**: none currently use `gotoCliToken()` (confirmed via grep on `e2e/`); removing the page-object method is safe. After C8, verify Playwright suite still passes.
- **Manual test artifact** ([docs/archive/review/deprecate-legacy-extension-token-manual-test.md](./deprecate-legacy-extension-token-manual-test.md), Phase 2 deliverable per R35 Tier-1):
  - Cold-boot the app (Docker compose up).
  - `curl -X POST http://localhost:3000/api/extension/token` → assert 410 + `Deprecation: true` header + JSON envelope `{ "error": "EXTENSION_TOKEN_LEGACY_ISSUANCE_DEPRECATED" }`.
  - Verify the **dead-letter log line** `event=extension_token_legacy_issuance_blocked` appears in app stdout (NOT `audit_outbox` — per C6 §Tenant resolution behaviour, anonymous emissions with no resolvable tenantId go to the dead-letter logger).
  - **Authenticated check**: send the same curl with a valid session cookie attached. Verify same response (410 + header + envelope). Expected behaviour: still routes to dead-letter because the handler intentionally skips `auth()` (per C1 forbidden patterns) and never reads the cookie — so even with a cookie present, no userId/tenantId is available for the audit emission.
  - Verify the audit log UI Filter dropdown surfaces `EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` as a selectable action with the localized label (en/ja) — even though zero rows match in `audit_outbox` post-deploy (the action is registered in the group, so it appears in the filter).
  - Confirm the Developer settings sidebar no longer shows "CLI Token" link.
  - Confirm `/dashboard/settings/developer/cli-token` returns Next.js 404.
  - Confirm extension v0.4.51+ continues to autofill (smoke test the bridge flow).
- **Build verification**: `npx next build` mandatory.

## Considerations & constraints

### §1 — Why no env flag for "re-enable legacy"

Rejected because:
1. Both consumer paths (extension v0.4.51+, CLI OAuth PKCE) are production-ready replacements.
2. Rollback via `git revert` is faster than env rollout.
3. Feature flags for code deletion grow stale.
4. The audit row + `logger.warn` is sufficient observability.

### §2 — Why reduce the POST handler to "audit + 410" instead of deleting it outright

1. Deleting the route yields a generic 404 from Next.js, indistinguishable from a typo.
2. 410 with the named error code gives clients actionable diagnostics and produces an auditable trail.
3. Full deletion is scheduled for the next Minor release after one observation window of zero `EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED` audit events.

### §3 — Backward-compatibility for old extension installs

Browser extension auto-updates via Chrome Web Store / Edge Add-ons within ~24h of publish. Users on extension < v0.4.51 will see:

- Existing tokens continue to work until expiry.
- Existing tokens refresh via `/api/extension/token/refresh` (unchanged).
- After token expiry, the popup's existing error UX surfaces a generic error (the bridge-flow re-pair UX path was added in v0.4.51 — pre-v0.4.51 popups have no in-app recovery CTA for this).
- Recovery for a stuck pre-v0.4.51 install: wait for auto-update, or manual reinstall.

Honest characterization: this is a degraded mode for the unlikely sub-population on pre-v0.4.51 extensions, not a "non-blocking" mode as the prior plan revision claimed. No data loss; no auth lockout; no break-glass needed.

### §4 — Out of scope (explicit deferrals)

- **P1: Bind bridge code to extension-held key.** Tracked separately.
- **P1: DPoP-bound browser extension tokens.** Same tracker.
- **P2: CLI keychain integration.** Different codebase, independent timeline.
- **Full removal of the POST handler.** Scheduled Minor release after one observation window.
- **OAuth PKCE UX polish on the Developer settings page.** The settings page after C8 may benefit from a documentation card pointing CLI users to `passwd-sso login`. Not gating this PR — can be a follow-up.

### §4a — Pre-screening + Round 1 reconciliation notes

- **R2 (literal `410`)**: matches existing precedent (`SHARE_GONE` uses `410` literal; no `HTTP_STATUS.GONE` shared constant exists). Not actionable.
- **OpenAPI**: `grep -n 'extension/token' src/lib/openapi-spec.ts` → 0 matches. Endpoint is not in `/api/v1/*`. Not actionable.
- **CSRF gate behavior**: removing `auth()` from `handlePOST` does NOT widen the CSRF surface. The proxy CSRF gate ([src/lib/proxy/csrf-gate.ts:42-47](../../../src/lib/proxy/csrf-gate.ts#L42-L47)) fires on the request-attribute predicate (`session cookie present + mutating method`), independently of handler logic. Cookie-bearing cross-origin POSTs are still 403'd before reaching the handler. Cookieless cross-origin POSTs reach the handler and receive 410 — same as before, with the status code being the only behaviour change.
- **F1 (CliTokenCard)**: scope expanded — see C8 + file matrix #11-20.
- **F2 (API_ERROR shape)**: contract C3 rewritten to match actual codebase shape (3 maps + 2 JSON files).
- **F3 (Prisma migration)**: added as C5. The file matrix gained a `prisma/migrations/...` entry and a `prisma/schema.prisma` edit.
- **F4 (R12 hedge)**: walkthrough now states the exhaustiveness checks at `audit.test.ts:71-77` and `:213-221` exist and are satisfied by PERSONAL.AUTH placement.
- **F5 (§3 backward-compat overstatement)**: §3 rewritten honestly — degraded mode acknowledged.
- **F6 / T1 (anonymous audit emission)**: added as C6 — use `ANONYMOUS_ACTOR_ID` + `ACTOR_TYPE.ANONYMOUS` with existing `logAuditAsync()`. No new helper.
- **S1 (DoS via audit)**: added as C7 — IP-keyed rate limiter on the 410 path.
- **S2 (dead-letter routing)**: documented in C6. `logger.warn` is the primary observability surface; `audit_outbox` row is best-effort.
- **T2 (audit mock missing)**: C4 specifies `vi.mock("@/lib/audit/audit", ...)` explicitly, pattern from `exchange/route.test.ts:71-76`.
- **T3 (POST test enumeration)**: C4 lists 5 new tests + 5 deletions explicitly.
- **T4 (Deprecation header invocation)**: C1 pseudocode includes the 4-arg `errorResponse(...)` call with headers object; C4 includes the header assertion.
- **T5 (stale POST-only mocks)**: C4 invariants list the mocks to remove and the mocks to keep.
- **T6 (RT3: import error code)**: C4 forbidden-pattern grep added.
- **T7 (proxy.test.ts naming)**: deferred — descriptive-only, no behavioural impact. Tracked as a TODO in Anti-Deferral §6 below.

### §4b — Round 2 reconciliation notes

All Round 2 findings have been applied:

- **F9 (Major, sidebar parent)**: matrix #14 rewritten to state factually that "Developer" parent retains `api-keys` + `mcp-connections` siblings; no parent-removal logic.
- **F10 (Minor, migration slug)**: matrix #5 slug corrected to `add_extension_token_legacy_issuance_blocked_audit_action` (matches repo convention).
- **S3 (Major, false acceptance-criterion claim)**: C7 "Acceptance criteria" rewritten — `checkRateLimitOrFail` only emits audit on the 503 (Redis-error) branch, NOT on 429. The plan no longer asserts "checkRateLimitOrFail handles 429 audit emission" (which was factually wrong per `rate-limit-audit.ts:238-258`). Scenario E rewritten to surface this: 429 observability is the limiter's internal `pre_auth_skip` warn log, not `audit_outbox`.
- **S4 (Minor, helper composition divergence with IPv6 implications)**: C7 signature rewritten to use `checkIpRateLimit` + `checkRateLimitOrFail({ result, ... })` two-step pattern, matching `exchange/route.ts:78-91`. `rateLimitKeyFromIp` arity corrected (1-arg, not 2-arg) — owned internally by `checkIpRateLimit` for IPv6 /64 collapse.
- **S5 (Minor, orphan translation keys)**: matrix #14b added — removes `subTab.cliToken` from both `messages/{en,ja}/Settings.json`.
- **T8 (Major, mock-name inventory)**: C4 §"Remove" rewritten with actual symbol names verified against `route.test.ts` (`mockAuth`, `mockCreate`, `mockFindMany`, `mockUpdateMany`, `mockTransaction`, `mockRequireRecentSession`, `mockUserFindUnique`, `mockWithUserTenantRls` — NOT the `mockExtensionToken*`-style names). The `vi.mock("@/auth", ...)`, `vi.mock("@/lib/auth/session/step-up", ...)`, `vi.mock("@/lib/tenant-context", ...)` blocks listed for removal.
- **T9 (Major, test #3 spy)**: dropped POST test #3 from C4 — relies on C1's forbidden-pattern grep for enforcement instead. This avoids needing a new `vi.mock("@/lib/auth/tokens/extension-token", ...)` spy that would otherwise create circular mock dependency for a test that proves a negative.
- **T10 (Minor, additional vi.mock blocks)**: C4 §"Add" extended with the 4 required vi.mock blocks (audit, ip-access, rate-limit-audit, logger) per the C1 + C7 helper graph. Explicit note added: do NOT copy `personalAuditBase` from `exchange/route.test.ts`.
- **T11 (Minor, manual-test inconsistency)**: §Testing strategy manual-test step rewritten — step 3 now asserts the dead-letter log line, NOT `audit_outbox`; new step added for authenticated cookie check (still routes to dead-letter, intentionally).
- **T12 (Minor, MAX_ACTIVE coverage gap)**: tracked in §6 TODOs with "required action before merge" obligation — Phase 2 must port the MAX_ACTIVE test to `exchange/route.test.ts` if absent there. Anti-Deferral check: pre-existing coverage being silently deleted → migrate, not skip.

Total post-Round 2 file count: 11 backend + 11 frontend = **22 file operations** (added #14b for Settings.json keys).

### §5 — Risk register

| Risk | Likelihood | Worst case | Mitigation |
|------|-----------|------------|------------|
| Non-extension / non-CLI caller exists that grep missed | Low | Caller breaks; sees 410 | Audit row + `logger.warn` surfaces the caller; revert PR. |
| Extension < v0.4.51 install fails to re-pair after token expiry | Low | User cannot autofill until they update | Chrome Web Store auto-update; manual reinstall fallback. |
| R12 group-coverage gap | Low | Action shows raw key in UI | Phase 2 enumeration + Phase 3 sub-agent check; `audit.test.ts:213-221` exhaustiveness fails CI loud. |
| Test that asserts "POST returns 201" survives the migration | Certain | CI fails | C4 explicitly lists all 5 deletions; mechanical grep `status:\s*201` enforces. |
| Prisma migration runs inside a transaction → `ALTER TYPE` fails | Low (Prisma generates correctly by default) | Migration aborts | Inspect generated file before commit; verify no `BEGIN;` wrapper. |
| Anonymous audit goes to dead-letter (no tenant resolution) | Certain (by design) | `audit_outbox` rows missing for unauthenticated callers | `logger.warn` log line is the primary signal; documented in §5 risk + C6. |
| IP-keyed rate limit blocks legitimate ops curl during smoke test | Low | Manual test gets 429 | 10/15min cap is generous; ops can wait or use a fresh source IP. |

### §6 — Tracked TODOs (Anti-Deferral compliance)

- **TODO(deprecate-legacy-extension-token, T7)**: rename `proxy.test.ts:97-104` test description from `"bypasses session check for Bearer + /api/extension/token (revoke)"` to reflect the post-deprecation reality that POST is always 410 and DELETE is the only Bearer-meaningful method. Cost: 1 LOC, < 5 min. Deferred because purely descriptive — does not affect behaviour or coverage. Anti-Deferral check: "out of scope (cosmetic)"; cost-to-fix is well under 30 minutes; the cost reason is bundling: doing it inside this PR would expand grep noise without behavioural change.
- **TODO(deprecate-legacy-extension-token, T12)**: verify whether `extension/token/exchange/route.test.ts` covers the `MAX_ACTIVE` rotation branch of `issueExtensionToken` (Round 2 grep returned 0 matches for "MAX_ACTIVE" / "revokes oldest" in that file). The `issueExtensionToken` helper is still in use by the bridge-code flow, so the rotation branch is live code — but the test that exercised it is being deleted in C4. **Required action before merge** (NOT deferred): Phase 2 reviewer MUST grep `MAX_ACTIVE` in `exchange/route.test.ts` once the file matrix is applied; if absent, port the MAX_ACTIVE test from the legacy route.test.ts to exchange/route.test.ts in this PR. Anti-Deferral check: "pre-existing coverage that this PR would silently delete" — covered helper still in use → MUST migrate, not skip. Cost-to-fix: under 30 min (port one `it()` block).

## User operation scenarios

### Scenario A: Extension user on v0.4.51 (dominant case)

Unchanged from current behaviour.

### Scenario B: Extension user on v0.4.51, token expired beyond refresh window

Bridge-code flow (unchanged): web app issues bridge code → content script exchanges → token forwarded to background.

### Scenario C: Extension user on < v0.4.51 (unlikely)

Popup calls `POST /api/extension/token` directly → receives 410 + `Deprecation: true` header. Popup's existing generic error UX shows "could not generate token." Recovery: Chrome Web Store auto-update + re-pair. Manual reinstall is the backstop.

### Scenario D: CLI user (post-deletion of CliTokenCard)

User runs `passwd-sso login` → OAuth 2.1 PKCE flow opens browser → user consents on `/api/mcp/authorize/consent` (or equivalent CLI consent page) → CLI receives token via loopback callback → token stored in `$XDG_DATA_HOME/passwd-sso/credentials`. The `--token` manual paste mode (`passwd-sso login --token=<...>`) is no longer documented; if any user tries to mint a token manually, they discover the Developer settings page no longer offers the button and must use the OAuth flow.

### Scenario E: Operations team observing for surprise traffic

**Primary signal**: `grep "extension_token_legacy_issuance_blocked"` in application logs (warn level). Both authenticated and unauthenticated 410 paths emit this line. Expected count zero.

**Secondary signal**: audit log dashboard filter `action = EXTENSION_TOKEN_LEGACY_ISSUANCE_BLOCKED`. Rows for unauthenticated callers (no resolvable tenantId) route to the dead-letter logger and DO NOT appear here — so a zero count is ambiguous between "no traffic" and "all traffic was anonymous."

**Tertiary signal** (Redis-error edge): `grep "rate-limit.fail_closed.pre_auth_skip"` with `scope=ext_token_legacy_blocked` indicates the 429 rate-limit fired during a Redis outage.

Non-zero on the primary signal → investigate by IP / User-Agent in the warn log line.

## R-rule applicability (Plan-phase pre-scan, updated post-Round 1)

- **R1 (shared utility reimplementation)**: pass — C6 uses existing `logAuditAsync`; C7 uses existing `extractClientIp` + `rateLimitKeyFromIp` + `checkRateLimitOrFail` + `createRateLimiter` helpers. No reimplementation.
- **R2 (constants hardcoded)**: pass — `410` matches `SHARE_GONE` precedent; no shared HTTP status constant exists.
- **R3 (incomplete pattern propagation)**: pass — C2 walkthrough enumerates AUDIT_ACTION surface; C8 forbidden-pattern grep enforces complete CliTokenCard removal.
- **R12 (enum/action group coverage)**: covered by C2.
- **R14 (DB role grant completeness)**: pass — enum value addition does not require role grant changes (audit_outbox_worker INSERTs into `audit_logs` with the new value once the enum type accepts it).
- **R15 (hardcoded env-specific values in migrations)**: pass — `ALTER TYPE` does not reference any environment-specific value.
- **R17 / R22 (helper adoption forward + inverted)**: pass — C6 explicitly rejects introducing a new helper.
- **R29 (external spec citation)**: RFC 9110 §15.5.11 (410 Gone), RFC 9745 (Deprecation header, Dec 2024). Both verified by Round 1 reviewers.
- **R31 (destructive operations)**: pass — no destructive DB ops in migration (additive enum value only). File deletions (C8) are reversible via git. **C8 file deletions DO touch user-facing UI surface** but are recoverable via revert; not in the R31 "destructive operations" categories (a-i) which target shared/production state.
- **R35 (production-deployed component, Tier-1)**: applies — manual-test artifact named in §Testing strategy.
- **R36 (suppression as substitute for fix)**: pass — no suppressions introduced.
