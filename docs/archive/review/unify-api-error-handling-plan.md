# Unify API Error Handling — Plan

## Project context

- **Type**: web app + REST API + SCIM provider + MCP gateway + browser extension consumer (multi-surface single repo)
- **Test infrastructure**: unit (Vitest) + integration (real Postgres) + E2E (Playwright) + CI/CD (GitHub Actions)
- **Languages**: TypeScript everywhere
- **Pre-1.0**: yes (`0.x.y`) — breaking shape changes are permissible per `CLAUDE.md` versioning policy, but this plan intentionally avoids them (scope: standard definition + gap fix, NOT migration to a different envelope shape)

## Objective

The codebase already has a mature, centralized API error handling system: `API_ERROR` enum (147 codes, verified at `src/lib/http/api-error-codes.test.ts:121`), `apiErrorToI18nKey()` translator, `errorResponse()` helper, RFC-compliant variants for SCIM/OAuth/JSON-RPC. The convention is mostly implicit, however, and a small number of drift spots have accumulated.

**Goal**: codify the existing convention as a written specification at `docs/api/error-handling.md`, fix the discrete gaps detected in the survey, and add a guard rail so future deviations are caught.

**Out of scope** (deliberate exclusions, per user-confirmed scope decision):

- Migrating the main API to RFC 7807 Problem+JSON
- Changing the server response shape from `{ error: CODE }` to anything else
- Adding `requestId` / `traceId` to every error response (separate observability plan)
- Adding server-side English/Japanese message strings to error responses (current "code-only, i18n on client" pattern is retained)
- Refactoring SCIM, OAuth/MCP, or JSON-RPC error formats (they correctly follow external RFCs)
- Touching the ~316 `unauthorized()` / 30+ `forbidden()` / 30+ `notFound()` call sites that already use helpers correctly

## Requirements

### Functional

1. The standard MUST be documented at `docs/api/error-handling.md` so new API authors can find it before writing the first route. Linked from `CLAUDE.md` "Architecture" section.
2. The four error envelopes (Main API, SCIM, OAuth, JSON-RPC) MUST each have a one-paragraph identification rule ("if a route path matches X, the envelope is Y") so the choice is mechanical, not interpretive.
3. The discrete gaps detected in the survey MUST be fixed (see Contracts C5-C8).
4. The HTTP status code semantics MUST be enumerated so that authors know when to use 400 vs 422, 401 vs 403, 404 vs 403, 409 vs 400, etc.

### Non-functional

1. No behavioral change visible to existing API consumers. Wire shapes that already-shipped clients rely on MUST remain byte-identical, except for the four fixed gaps (each with a justification in this plan).
2. The standard MUST be enforceable by `grep` / ESLint pattern so future drift can be caught. A grep-based check is sufficient; no full AST analysis is required.
3. No new runtime dependency.

## Technical approach

### Two-artifact split

- `docs/archive/review/unify-api-error-handling-plan.md` — this file. Time-bounded work plan, deleted from active reference once merged.
- `docs/api/error-handling.md` — permanent specification. Linked from `CLAUDE.md`. Updated as the standard evolves; never garbage-collected.

### Envelope identification rule

The route prefix determines the envelope (mechanical, not interpretive):

| Route prefix | Envelope | Codes | Source of truth |
|--------------|----------|-------|-----------------|
| `/api/scim/v2/*` | RFC 7644 SCIM Error | `urn:ietf:params:scim:api:messages:2.0:Error` | `src/lib/scim/response.ts:scimError()` |
| `/api/mcp/authorize`, `/api/mcp/authorize/consent` | RFC 6749 OAuth Error (authorization endpoint) | `invalid_request`, `unauthorized_client`, `access_denied`, `unsupported_response_type`, `invalid_scope`, `server_error`, `temporarily_unavailable` per RFC 6749 §4.1.2.1 | inlined; see C9 |
| `/api/mcp/token`, `/api/mcp/revoke`, `/api/mcp/register` | RFC 6749 OAuth Error (token endpoint) | `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope` per RFC 6749 §5.2; device-flow additions `slow_down`, `authorization_pending`, `expired_token` per RFC 8628 §3.5 | inlined; see C9 |
| `/api/mcp/.well-known/oauth-authorization-server` | RFC 8414 discovery metadata (200 only — not an error surface in normal use; 404 if missing) | n/a | inlined |
| `/api/mcp` (POST JSON-RPC body) | JSON-RPC 2.0 Error | numeric `code` (`-32700`/`-32600`/`-32601`/`-32602`/`-32603`/`-32000`..`-32099`) | `src/lib/mcp/server.ts` |
| All other `/api/*` | Main API Error | `API_ERROR` enum (TypeScript) | `src/lib/http/api-error-codes.ts` |

The four envelopes do not mix. Cross-envelope wrapping (e.g., returning an OAuth-style error from a `/api/passwords/*` route) is a forbidden pattern (see Contracts → Forbidden patterns).

### Main API envelope (the dominant case)

The shape is:

```typescript
// Wire shape (what arrives over HTTP):
// Required field — always present, always one of the API_ERROR codes
{ error: ApiErrorCode }

// With optional context fields — the closed list below
{ error: ApiErrorCode, details: unknown }                    // VALIDATION_ERROR only; `unknown` is z.treeifyError() output (a tree)
{ error: "ACCOUNT_LOCKED", lockedUntil: string | null }      // ISO 8601 string when known; null when lockout has no expiry
{ error: "CONFLICT", currentKeyVersion: number }              // webauthn PRF CAS path only
// RATE_LIMIT_EXCEEDED — no body context field; the helper emits `Retry-After` header only
```

The closed list of optional context fields appears in Contract C4. Adding a new context field requires updating the contract (and `docs/api/error-handling.md`) — ad-hoc additions are forbidden.

**Note on rate-limit and `retryAfterMs`**: An earlier draft of this plan incorrectly claimed `retryAfterMs` is a body field. Verified at `src/lib/http/api-response.ts:58-64`: the `rateLimited(retryAfterMs?)` helper emits ONLY the `Retry-After` HTTP header (converted to seconds, ceiling-rounded), NEVER spreads into the body. All call sites that pass `retryAfterMs` (audit-logs/download, maintenance/*, webauthn/credentials/[id]/prf, etc.) go through `rateLimited()` so this invariant is consistent. Consumer E (rate-limited callers) MUST read `Retry-After` from headers; no body context exists.

**Note on `lockedUntil` nullability**: Verified at `src/lib/auth/policy/account-lockout.ts:112,117,135,140,143` — `LockoutStatus.lockedUntil` is typed `Date | null`. In the `locked === true` branch the value is non-null in practice for the three production sites (`vault/unlock/route.ts:47-48`, `:105-107`, `travel-mode/disable/route.ts:36-37`), but the type is not narrowed via discriminated union and downstream serialization preserves `null`. The wire shape is therefore `{ lockedUntil: string | null }`. Consumer C's helper `formatLockedUntil(lockedUntil: string | null | undefined)` at `src/components/vault/vault-lock-screen.tsx:27` already tolerates null. The contract reflects observed runtime shape.

**Helper-input shape (distinct from wire shape)**: `errorResponse(code, status, details?, headers?)` takes `details?: Record<string, unknown>` as its third arg. Callers spread that object into the body. So the call site looks like:

```typescript
errorResponse(API_ERROR.VALIDATION_ERROR, 400, { details: z.treeifyError(err) })
// → wire: { error: "VALIDATION_ERROR", details: <tree> }

errorResponse(API_ERROR.ACCOUNT_LOCKED, 403, { lockedUntil: iso })
// → wire: { error: "ACCOUNT_LOCKED", lockedUntil: "2026-..." }

rateLimited(retryAfterMs)
// → wire body: { error: "RATE_LIMIT_EXCEEDED" }
// → wire header: Retry-After: <seconds>
```

The third argument's TYPE constrains the helper input; what the consumer sees on the wire is the spread result. C4's closed list governs the WIRE shape; the helper accepts anything that conforms to it because `Record<string, unknown>` is permissive — discipline at the call site is what enforces C4.

**Note on `ITEM_KEY_VERSION_DOWNGRADE`**: this code's current production emission at `src/lib/services/team-password-service.ts:361` is the bare shape `{ error: "ITEM_KEY_VERSION_DOWNGRADE" }` with status **400**, NOT paired with `currentKeyVersion`. The client recomputes versioning state from the next read; no `currentKeyVersion` body field is needed at this site.

### Client consumption

Unchanged. Stays as:

```typescript
const tApi = useTranslations("ApiErrors");
await toastApiError(res, tApi);
// OR for domain-specific overrides:
tApi(apiErrorToI18nKey(code, { NOT_FOUND: "shareNotFound" }));
// OR for EmergencyAccess namespace:
t(eaErrorToI18nKey(data?.error));
```

This pattern is already documented in inline comments of `src/lib/http/api-error-codes.ts:11-18`; the new spec quotes that block verbatim so the source of truth is single-sided.

### HTTP status code semantics (the "AND, not OR" answer)

HTTP status code AND `error` code are used **together (AND)**, not either-or. The HTTP code is the broad class (so generic HTTP clients, browser dev tools, log aggregators, and CDN policies behave correctly); the `error` code is the specific reason (so the client can branch on a stable identifier across spec revisions).

| HTTP | When | Example codes |
|------|------|---------------|
| 400 | Malformed input — request cannot be parsed or fails Zod validation | `INVALID_JSON`, `VALIDATION_ERROR`, `INVALID_CURSOR`, `INVALID_PREFIX`, `INVALID_BODY` |
| 401 | No identity — caller did not authenticate, or session/token is invalid/expired | `UNAUTHORIZED`, `INVALID_SESSION`, `API_KEY_INVALID`, all `MOBILE_*` |
| 403 | Identity OK, permission insufficient — role, scope, tenancy, recency, or origin restriction denies access | `FORBIDDEN`, `FORBIDDEN_INSUFFICIENT_ROLE`, `ACCESS_DENIED` (after C5), `SESSION_STEP_UP_REQUIRED`, `*_SCOPE_INSUFFICIENT`, `OWNER_ONLY`, `ONLY_OWN_ENTRIES`, `NOT_AUTHORIZED_FOR_GRANT`, `ACCOUNT_LOCKED` |
| 404 | Resource does not exist in this caller's scope | `NOT_FOUND`, `USER_NOT_FOUND`, `TEAM_NOT_FOUND`, `*_NOT_FOUND` family |
| 409 | Request conflicts with current resource state | `CONFLICT`, `VAULT_ALREADY_SETUP`, `*_ALREADY_EXISTS`, `*_ALREADY_REVOKED`, `ALREADY_A_MEMBER`, `SLUG_ALREADY_TAKEN` |
| 410 | Endpoint deprecated and removed | (deprecated route stubs) |
| 413 | Body exceeds size limit | `PAYLOAD_TOO_LARGE`, `FILE_TOO_LARGE`, `SEND_FILE_TOO_LARGE` |
| 422 | Semantic validation of well-formed input failed (rare — see Contract C6) | reserved; see C6 |
| 429 | Rate limit exceeded | `RATE_LIMIT_EXCEEDED` |
| 500 | Server-side bug — unexpected failure | `INTERNAL_ERROR` |
| 503 | Downstream dependency unavailable (Redis, WebAuthn, HIBP, etc.) | `SERVICE_UNAVAILABLE`, `UPSTREAM_ERROR` |

**Note on lockouts**: `ACCOUNT_LOCKED` is **403** today (3 sites — see Contract C7). RFC 4918 §11.3 defines 423 Locked, which is semantically more precise, but the migration is out of scope for this plan.

#### 400 vs 422 (Contract C6)

Standard: use **400 for all input-shape failures**. Reserve 422 for cases where the body parses, Zod accepts it, but a multi-field semantic invariant fails (e.g., `startDate > endDate` when both fields individually validate). The single current 422 in `src/app/api/maintenance/audit-chain-verify/route.ts:204` is reviewed under C6 to confirm it falls in this narrow class; if not, it is downgraded to 400.

#### 401 vs 403 (clarification, not change)

The boundary is whether the **server knows who is making the request AND trusts that identity for THIS action**:

- No identity (no cookie/token, or token invalid/expired) → 401
- Identity present, action denied (wrong role, missing scope, tenant restriction, origin mismatch, OR session too old for high-assurance action) → 403

`SESSION_STEP_UP_REQUIRED` is **403** in this codebase (verified at `src/lib/auth/session/step-up.ts:48` and `src/lib/auth/webauthn/recent-passkey-verification.ts:52,56`). Rationale: the caller's identity is established and still valid for low-assurance actions; the server is refusing THIS specific action because the session is older than the step-up window. This is closer to "permission insufficient for the action's required assurance level" (403) than "no identity" (401).

**Comparison with RFC 9470**: RFC 9470 (OAuth 2.0 Step Up Authentication Challenge Protocol) §3 specifies **401 Unauthorized + `WWW-Authenticate: insufficient_user_authentication`** for step-up. Our use of 403 is a deliberate divergence: we treat step-up as authorization rather than authentication semantics, and we communicate the requirement via the `error` code instead of the `WWW-Authenticate` header. Two reasons not to migrate:
1. The header-based RFC 9470 contract requires client-side `WWW-Authenticate` parsing across CLI/iOS/extension surfaces — out of scope for this minimum-scope plan.
2. Our existing CLI/extension/UI handlers already dispatch on `error === "SESSION_STEP_UP_REQUIRED"` (see `src/components/settings/developer/*.tsx`, `src/hooks/auth/use-inline-reauth.ts:32`) — a status-only switch to 401 would invite naïve "session expired → re-login at AAL1" handling that defeats the step-up requirement.

The `docs/api/error-handling.md` spec MUST include this footnote: "Clients receiving `SESSION_STEP_UP_REQUIRED` MUST dispatch on the `error` code, NOT the HTTP status — the code is the stable contract. Migration to RFC 9470's 401 + WWW-Authenticate is NOT planned because our 403 + code-dispatch is intentional."

## Contracts

Every contract below is locked at the Go/No-Go Gate before Phase 2 begins. Contract IDs are stable across rounds — citations in later rounds reference `C1`/`C2`/etc., never paraphrase.

---

### C1 — Envelope identification rule

**Signature**: `classifyEnvelope(pathname: string): "main" | "scim" | "oauth" | "jsonrpc"`

**Invariants**:
- `/api/scim/v2/*` → `"scim"`
- `/api/mcp/authorize`, `/api/mcp/authorize/consent`, `/api/mcp/token`, `/api/mcp/revoke`, `/api/mcp/register`, `/api/mcp/.well-known/oauth-authorization-server` → `"oauth"`
- `/api/mcp` exact match → `"jsonrpc"` (the Streamable HTTP / SSE endpoint)
- Everything else under `/api/*` → `"main"`

**Forbidden patterns**:
- `pattern: NextResponse\.json\(\s*\{\s*error_description` outside `/api/mcp/{authorize,authorize/consent,token,revoke,register}` — reason: OAuth envelope must not leak into non-OAuth routes
- `pattern: "schemas":\s*\[\s*"urn:ietf:params:scim` outside `src/lib/scim/` — reason: SCIM envelope must not leak into non-SCIM routes
- `pattern: jsonrpc:\s*"2\.0"` outside `src/lib/mcp/` and `/api/mcp/route.ts` — reason: JSON-RPC envelope must not leak into other routes

**Acceptance**: a static table in `docs/api/error-handling.md` lists the four envelopes with their route prefixes verbatim from above. No code change required for C1 itself — this contract is documentation of an existing implicit rule.

---

### C2 — Main API error envelope shape

**Signature**:

```typescript
type MainApiErrorBody =
  | { error: ApiErrorCode }
  | { error: ApiErrorCode; details: unknown }
  | { error: ApiErrorCode } & ContextField;

type ContextField =
  | { lockedUntil: string | null }       // ISO 8601 string when known; null when expiry unknown; with ACCOUNT_LOCKED only
  | { currentKeyVersion: number };       // with CONFLICT only (webauthn PRF CAS at credentials/[id]/prf/route.ts:223)
// Note: RATE_LIMIT_EXCEEDED has NO body context field — `Retry-After` header carries the wait duration.
```

**Invariants**:
- The wire shape is always JSON with `Content-Type: application/json`.
- The HTTP status comes from the table in "HTTP status code semantics" above.
- `error` is always a member of `API_ERROR` (typed `ApiErrorCode`) and matches the regex `^[A-Z][A-Z0-9_]+$` (UPPER_SNAKE_CASE).
- `details` is only present on `VALIDATION_ERROR` and contains `z.treeifyError(...)` output (an object tree, never a plain string). The legacy plain-string `details` at `webauthn/register/verify/route.ts:88` is migrated under C6.
- `lockedUntil` carries the ISO 8601 string OR null (see "Note on lockedUntil nullability" above). The field is always present on `ACCOUNT_LOCKED` responses, even when null — consumers parse `null` as "no known expiry".
- `RATE_LIMIT_EXCEEDED` responses MUST include `Retry-After` header (seconds, ceiling-rounded). No body context field.
- Any body context field other than `details`, `lockedUntil`, `currentKeyVersion` is forbidden until C2 is amended.

**Forbidden patterns**:
- `pattern: NextResponse\.json\(\s*\{\s*error:\s*"[a-z]` outside `src/app/api/scim/` and `src/app/api/mcp/{authorize,authorize/consent,token,revoke,register}` — reason: enforces UPPER_SNAKE_CASE; catches accidental snake_case OAuth-style leakage into main-API routes
- `pattern: NextResponse\.json\(\s*\{\s*error:\s*"[A-Z][^"]*\s` outside `src/app/api/scim/` and `src/app/api/mcp/` — reason: catches English-prose strings as `error` value (e.g., `"Seed row for chain_seq... not found"` at audit-chain-verify:203 — see C6)
- `pattern: NextResponse\.json\(\s*\{\s*message:` outside `src/app/api/mcp/` — reason: catches accidental Java-style `{ message, error }` shape

**Acceptance criteria**:
- `docs/api/error-handling.md` § "Main API envelope" reproduces the type definition verbatim.
- The three permitted context fields are listed with their associated codes.

**Consumer-flow walkthroughs** (paths verified against the repo as of plan creation):

- Consumer A (path: `src/lib/http/toast-api-error.ts`) reads `{ error }` from the body and uses `error` as input to `apiErrorToI18nKey()` to derive the i18n key for the toast. Required field: `error`.
- Consumer B (path: `src/components/share/share-password-gate.tsx`) — this consumer was previously cited at :67 incorrectly; line 67 reads `data.accessToken`, NOT the error code. The share-password gate uses dedicated i18n keys (`t("tooManyAttempts")`, `t("wrongPassword")`) for known HTTP-status branches and does NOT use the `apiErrorToI18nKey(..., overrides)` pattern. The `overrides` parameter of `apiErrorToI18nKey` is documented as a public API in `api-error-codes.ts:11-18` and has test coverage at `src/components/vault/rotate-key-dialog.test.tsx:158`, `src/components/vault/change-passphrase-dialog.test.tsx:158` (fallback path) — but the override-with-domain-key pattern is currently used by no production component beyond what those tests exercise. The contract documents `apiErrorToI18nKey` as the canonical API including the overrides hook for future per-domain customization; no production consumer needs to be cited here.
- Consumer C (path: `src/components/vault/vault-lock-screen.tsx`, with helper `formatLockedUntil` at :27 accepting `string | null | undefined`) reads `{ error, lockedUntil }` for `ACCOUNT_LOCKED` and uses `lockedUntil` to render a countdown until the lockout expires. Required fields: `error`, `lockedUntil` (ISO 8601 string OR null; per C2 invariants, the field is always present but may be null). The helper renders a generic message when null.
- Consumer D (path: `src/app/api/webauthn/credentials/[id]/prf/route.test.ts:152-165`, asserting the production response from `route.ts:223`) reads `{ error: "CONFLICT", currentKeyVersion }` and asserts the value. The Phase 2 implementer MUST grep `currentKeyVersion` consumers in production (`src/`) — if no production caller reads this field via `res.json()`, document in the deviation log and consider whether C4 should drop the field. The verified survey did NOT find a non-test consumer in `src/components/` or `src/hooks/`; the field may be vestigial. Decision deferred to Phase 2.
- Consumer E (path: rate-limited callers, generic) reads ONLY the `Retry-After` HTTP header — body has no `retryAfterMs`. Required body field: `error`. The earlier draft of this plan erroneously listed `retryAfterMs` as a body field; corrected per F13 in Round 2 review.
- Consumer F (Zod field-level error mapping; path: e.g., `src/components/team/security/team-scim-token-manager.tsx`, `src/components/settings/developer/*.tsx` form handlers — actual file paths from grep of `details.properties.*` and Zod tree consumers: `breakglass-dialog.tsx`, `team-create-dialog.tsx`, `base-webhook-card.tsx`, `mcp-client-card.tsx`) reads `{ error: "VALIDATION_ERROR", details }` where `details` is a `z.treeifyError()` tree, and walks the tree to assign per-field error strings to form inputs. Required fields: `error`, `details`. Field shape of `details` is whatever `z.treeifyError()` produces in Zod 4.

Plan reviewers MUST verify each consumer above has the listed fields satisfied by the current `errorResponse()` helper output OR by the existing extra-context-field call sites (`src/app/api/vault/unlock/route.ts:47,105`, `webauthn/credentials/[id]/prf/route.ts:223`, `travel-mode/disable/route.ts:36`). Any consumer requiring a field not in the contract is a contract-incompleteness finding.

---

### C3 — Client error consumption pattern

**Signature**:

```typescript
function apiErrorToI18nKey(
  error: unknown,
  overrides?: Partial<Record<ApiErrorCode, string>>,
): string;

function eaErrorToI18nKey(error: unknown): string;
```

**Invariants**:
- Default namespace is `ApiErrors` via `useTranslations("ApiErrors")`.
- Emergency Access UI (4 components — `grant-card`, `create-grant-dialog`, `invite/[token]`, `[id]/vault`) uses `EmergencyAccess` namespace and `eaErrorToI18nKey`.
- Domain overrides MUST go through the `overrides` parameter — they MUST NOT bypass `apiErrorToI18nKey` with a manually constructed switch.
- Unknown codes fall back to `"unknownError"` (ApiErrors) or `"actionFailed"` (EmergencyAccess). The fallback is opaque to the user ("An error occurred"); it MUST NOT leak the code value to UI.

**Forbidden patterns**:
- `pattern: switch.*err.*case ["']` in `src/components/` and `src/app/(?!api)` — reason: catches manual switch-on-error-code that bypasses `apiErrorToI18nKey`. Allow-list: `eaErrorToI18nKey` (the function being defined) and existing override sites identified via review.

**Acceptance**: `docs/api/error-handling.md` § "Client consumption" reproduces the inline comment block at `src/lib/http/api-error-codes.ts:11-18` verbatim, so the source of truth stays in the typed module; the spec links to that block.

---

### C4 — Closed list of context fields

**Signature**: see C2 body.

**Invariants**: only **three body context fields** are permitted — `details`, `lockedUntil`, `currentKeyVersion`. Rate-limit responses use the `Retry-After` HTTP header (NOT a body field; verified at `src/lib/http/api-response.ts:58-64`). Adding a new body context field requires:
1. Justification in a PR description (why a separate code does not suffice).
2. Update of C4 in `docs/api/error-handling.md` (table row).
3. TypeScript type added to `ContextField` union (so the type system enforces it).

**Forbidden patterns**:
- Adding a new top-level key to `NextResponse.json({ error: ... })` calls without referencing C4 in the PR description.

**Acceptance**:
- `docs/api/error-handling.md` has a "Context fields" section listing the three body fields (`details`, `lockedUntil`, `currentKeyVersion`) with their associated codes and types, plus a separate subsection for the `Retry-After` header used with `RATE_LIMIT_EXCEEDED`.
- An optional follow-up (Phase 2-side, not Phase 1): add a `MainApiErrorBody` TypeScript type to `api-response.ts` so future ad-hoc additions are caught at compile time. Tracked as a deviation in the plan; not blocking.

---

### C5 — ACCESS_DENIED gap fix

**Signature**: add `ACCESS_DENIED: "ACCESS_DENIED"` to `API_ERROR` and map it to a new i18n key `"accessDenied"`.

**Invariants**:
- The four production sites MUST switch from string-literal `"ACCESS_DENIED"` to `API_ERROR.ACCESS_DENIED`. Verified file paths and per-site header requirements:
  - `src/lib/proxy/api-route.ts:111-117` — this site emits `Cache-Control: no-store` header today. The migration MUST preserve it: `errorResponse(API_ERROR.ACCESS_DENIED, 403, undefined, { "Cache-Control": "no-store" })`. Also preserve the existing `applyCorsHeaders(request, ...)` wrapping for cross-origin browser visibility.
  - `src/lib/auth/policy/access-restriction.ts:242` — no Cache-Control header today; emit `errorResponse(API_ERROR.ACCESS_DENIED, 403)`.
  - `src/lib/auth/policy/access-restriction.ts:262` — same as :242.
  - `src/lib/auth/policy/access-restriction.ts:282` — same as :242.
- The wire string remains `"ACCESS_DENIED"` (byte-identical to today). HTTP status (403) and response headers (Cache-Control at the one proxy site only; CORS wrapping at the proxy site only) are unchanged.
- The ~14 test assertion sites that match `body.error === "ACCESS_DENIED"` (enumerated in Testing strategy below) remain green without modification (the wire string is unchanged).
- Add `"accessDenied": "Access denied."` to `messages/en/ApiErrors.json` and `"アクセスが拒否されました。"` to `messages/ja/ApiErrors.json`.
- Add the new code to the `API_ERROR_I18N` map in `api-error-codes.ts` (the `satisfies Record<ApiErrorCode, string>` constraint at line 375 enforces presence at compile time).
- Update `src/lib/http/api-error-codes.test.ts:121` from `.toBe(147)` to the new count. If C5+C6+C11 all ship in this PR, the final count is `149` (`147 + 3 from C5/C6 − 1 from C11 merge`). Set to actual `Object.keys(API_ERROR).length` at PR creation time.

**Forbidden patterns**:
- `pattern: NextResponse\.json\(\s*\{\s*error:\s*"ACCESS_DENIED"` outside `__tests__/` and `*.test.ts` — reason: catches future copy-paste of the old string-literal form. Production code MUST go through `errorResponse(API_ERROR.ACCESS_DENIED, ...)`.

**Acceptance**:
- `grep -rn '"ACCESS_DENIED"' src/ | grep -v '\.test\.\|__tests__/'` returns zero hits.
- Existing tests pass without modification (wire string unchanged).
- `npx vitest run src/lib/auth/policy src/lib/proxy src/__tests__/proxy.test.ts` passes.

**Note**: `AUDIT_ACTION.ACCESS_DENIED` at `src/lib/constants/audit/audit.ts:122` is a separate concern (audit event name, not API error code) and is NOT touched by this contract. The audit-action membership references at `src/lib/constants/audit/audit.ts:295` and `:592` (admin-actions group + tenant-actions group) remain unchanged. Verified audit emission in `src/lib/auth/policy/access-restriction.ts`: `logAuditAsync({ action: AUDIT_ACTION.ACCESS_DENIED, ... })` at function-call lines 176, 252, 272 (the `AUDIT_ACTION.ACCESS_DENIED` arg appears at 177, 253, 273). The corresponding `NextResponse.json(...)` lines are 242, 262, 282. Audit emission is fire-and-forget BEFORE the response, independent of response shape — the C5 source-side switch does not affect audit emission.

---

### C6 — Envelope violations and validation-details cleanup

**Signature**: convert two envelope-violating sites to use `API_ERROR` enum properly, and normalize the validation-details shape.

**Sites** (verified):

1. `src/app/api/maintenance/audit-chain-verify/route.ts:201-205` (prose template literal at :203; `{ status: 422 }` at :204) — returns `{ error: \`Seed row for chain_seq ${fromSeq - 1} not found — partial verification requires the preceding row\` }` (raw English template literal as `error` value) with status 422. **Bigger violation than just the 422 code**: the `error` value is not a member of `API_ERROR` (C2 invariant violation). Decision: this is a precondition failure on well-formed input (the request specified `fromSeq`; the seed row does not exist) — a semantic invariant. Use **400** (input refers to a non-existent seed row), introduce a new code `AUDIT_CHAIN_SEED_NOT_FOUND`, and remove the prose.
2. `src/app/api/webauthn/register/verify/route.ts:88` — returns `{ error: API_ERROR.VALIDATION_ERROR, details: "Challenge expired or already used" }` (plain string `details`). The `redis.getdel(...)` operation at line 85 returns null in BOTH the expired-TTL and already-consumed cases, so the body string was already lossy — it claimed to disambiguate but couldn't. Decision: introduce `INVALID_CHALLENGE` at 400 with no `details`. The i18n copy is generic — "Security key registration could not be completed. Please retry." (en) / "セキュリティキーの登録に失敗しました。もう一度お試しください。" (ja) — does NOT disambiguate expired vs. replayed (the wire already doesn't; the toast must not either).

**Invariants**:
- After C6, `VALIDATION_ERROR` is reserved for Zod parser output. Non-Zod "input doesn't make sense" errors get a domain-specific code.
- After C6, `details` is reserved for the `z.treeifyError()` tree (object shape). String `details` is forbidden going forward.
- New codes `AUDIT_CHAIN_SEED_NOT_FOUND` and `INVALID_CHALLENGE` are added to `API_ERROR` AND `API_ERROR_I18N`.

**Forbidden patterns**:
- `pattern: API_ERROR\.VALIDATION_ERROR.*details:\s*"` — string-typed `details`. Reason: callers (Consumer F in C2) expect a tree object.

**Acceptance**:
- The audit-chain-verify site at :201-205 uses `errorResponse(API_ERROR.AUDIT_CHAIN_SEED_NOT_FOUND, 400)` and no longer emits an English prose `error` value.
- The webauthn-register-verify site at :88 uses `errorResponse(API_ERROR.INVALID_CHALLENGE, 400)` (no `details`).
- `grep -rn 'API_ERROR\.VALIDATION_ERROR.*details:\s*"' src/` returns zero hits.
- Existing test that asserts the expired-challenge response at `src/app/api/webauthn/register/verify/route.test.ts` (the `it("returns 400 with VALIDATION_ERROR when challenge has expired", ...)` block) is updated to assert `INVALID_CHALLENGE` instead. The two SIBLING `VALIDATION_ERROR` assertions in the same file (`verifyRegistration throws`, `verified === false`) are unchanged — they exercise different code paths and remain at `VALIDATION_ERROR`.
- The `vi.mock("@/lib/http/api-error-codes", ...)` factory at `src/app/api/webauthn/register/verify/route.test.ts:91-99` is extended to include `INVALID_CHALLENGE: "INVALID_CHALLENGE"`. The new test asserts against the literal string `"INVALID_CHALLENGE"`, not against `API_ERROR.INVALID_CHALLENGE` from the mock — the literal protects against mock-reality drift.
- Update `src/lib/http/api-error-codes.test.ts:121` count to `149` (C5 + C6 + C11: `147 + 3 − 1 = 149`). Verify exact count at PR creation time.

---

### C7 — ACCOUNT_LOCKED status documentation (observation only)

**Verified sites and status codes**:

- `src/app/api/vault/unlock/route.ts:47-48` → 403 + `{ error: "ACCOUNT_LOCKED", lockedUntil }`
- `src/app/api/vault/unlock/route.ts:105-107` → 403 + `{ error: "ACCOUNT_LOCKED", lockedUntil }`
- `src/app/api/travel-mode/disable/route.ts:36-37` → 403 + `{ error: "ACCOUNT_LOCKED", lockedUntil }`

All three sites use **403**. Rationale: "lockout-as-authorization-denial" — the server has the caller's identity but refuses the action for a time-bounded reason.

**Note on RFC 4918 §11.3 (423 Locked)**: 423 is semantically more precise than 403 for time-bounded locks. Migration is out of scope for this plan (it is a wire-shape change visible to existing clients — the CLI, extension, and iOS app would all need updating to interpret 423). Tracked as: `TODO(account-locked-423): migrate ACCOUNT_LOCKED HTTP status from 403 to 423 per RFC 4918 §11.3 across all 3 sites; coordinate with CLI/extension/iOS releases`.

This contract is **observation-only**: no change to wire behavior.

**Acceptance**:
- `docs/api/error-handling.md` records "ACCOUNT_LOCKED → 403 (3 sites verified)" with the rationale.
- The TODO marker is grep-able in the doc.

---

### C8 — OpenAPI error schema tightening

**Signature**: refine the `ErrorResponse` schema at `src/lib/openapi-spec.ts:404-411`.

**Current**:
```typescript
ErrorResponse: {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },   // unconstrained string
    details: {},                  // unconstrained
  },
}
```

**Target**:
```typescript
ErrorResponse: {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "string",
      enum: [ /* all ApiErrorCode values, sourced from Object.values(API_ERROR) at module load time */ ]
    },
    details: { description: "Validation tree from z.treeifyError() — present only on VALIDATION_ERROR" },
    lockedUntil: {
      type: ["string", "null"],
      format: "date-time",
      description: "Present only on ACCOUNT_LOCKED; null when expiry is unknown"
    },
    currentKeyVersion: {
      type: "integer",
      description: "Present only on CONFLICT (webauthn PRF CAS path)"
    },
    // No body context for RATE_LIMIT_EXCEEDED — Retry-After header carries wait duration.
  },
}
```

**Invariants**:
- `enum` is sourced from `Object.values(API_ERROR)` at module load time (the OpenAPI spec is generated at runtime from `openapi-spec.ts`, so it is not a build-time concern — the array is computed once on first import).
- Public OpenAPI is the only contract surface exposed under `/api/v1`. Internal-only codes (`MOBILE_*`, `SCIM_*`, `MCP_*`, etc.) appear in the enum even if no `/api/v1` route returns them — including them costs nothing in spec size and avoids the need to maintain a curated subset.

**Forbidden patterns**: none new — C8 is opt-in tightening, not enforcement.

**Acceptance**:
- The OpenAPI JSON at `/api/v1/openapi.json` includes the enum-constrained `error` field.
- An OpenAPI consumer (e.g., Stainless / openapi-typescript-codegen) generates a typed union for `error`.

---

### C9 — OAuth error envelope (defer-or-fix decision)

**The surveyed inconsistency**: `src/app/api/mcp/revoke/route.ts:24` returns `{ error: "rate_limited", error_description: "..." }`. The string `"rate_limited"` is NOT defined by:
- **RFC 6749 §5.2** (token endpoint errors): valid codes are `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`.
- **RFC 7009 §2.2** (revoke endpoint): explicitly says the server "MUST respond with HTTP status code 200 if the token has been revoked successfully or if the client submitted an invalid token". RFC 7009 §2.2.1 (errors) inherits from RFC 6749 §5.2 for error cases. The 429 response itself is a deliberate abuse-mitigation deviation from the "always 200" rule — codifying this deviation in `docs/api/error-handling.md` is part of C9's job.
- **RFC 8628 §3.5** (device flow): defines `slow_down`, `authorization_pending`, `expired_token`. Applies only to the device authorization grant — not relevant to revoke.

**Decision**:
1. Keep the 429 rate-limit response (abuse mitigation; deliberately non-compliant with RFC 7009 §2.2's "always 200" rule).
2. Change the body from `{ error: "rate_limited", error_description: ... }` to one of:
   - **(a) Spec-aligned**: `{ error: "invalid_request", error_description: "Rate limit exceeded — try again later" }` plus `Retry-After` header. Forces the response into the §5.2 vocabulary; loose fit but doesn't introduce an unknown code.
   - **(b) Explicit extension**: `{ error: "rate_limited", error_description: "..." }` kept as-is, plus a code comment citing the deliberate extension and RFC 7009's "always 200" baseline. Documented in `docs/api/error-handling.md` § "Extensions to RFC 6749".
   - **(c) No-body 429**: drop the body entirely, return `429 + Retry-After` header only. Browser-style; least informative.
3. Pick (b) — it preserves observability and existing client behavior, and the documentation captures the deviation explicitly so future maintainers don't try to "fix" it back to a non-standard code without thinking.

**Anti-Deferral check**: pre-existing in unchanged file. Worst case: an OAuth client treats `rate_limited` as an unknown error and falls back to a generic-error retry strategy. Likelihood: low (no production MCP clients exercising revoke heavily; per RFC 7009 §2.2 most clients ignore the response anyway). Cost to fix (option b — code comment only): under 5 minutes. Decision: **fix in this PR** (option b). Add a code comment at `mcp/revoke/route.ts:24` citing RFC 7009 §2.2 + this plan.

**Acceptance**:
- `src/app/api/mcp/revoke/route.ts:24` has a code comment: `// Deliberate extension: RFC 7009 §2.2 says "always 200"; we return 429 + \`{ error: "rate_limited" }\` for abuse mitigation. See docs/api/error-handling.md § "Extensions to RFC 6749".`
- `docs/api/error-handling.md` § "OAuth/MCP envelope" includes an "Extensions" subsection listing this one deviation.
- No code change beyond the comment — the wire shape is unchanged.

---

### C10 — docs/api/error-handling.md content outline

**Signature**: new file at `docs/api/error-handling.md`, ~400-600 lines, structured as:

```
# API Error Handling

1. Overview (1-paragraph TL;DR; HTTP code AND error code, used together)
2. Envelope identification rule (Contract C1 table verbatim)
3. Main API envelope
   3.1 Wire shape (Contract C2 type definition verbatim)
   3.2 Context fields (Contract C4 closed list: 3 body fields — details, lockedUntil, currentKeyVersion — plus the `Retry-After` header for RATE_LIMIT_EXCEEDED)
   3.3 HTTP status code semantics (table verbatim from "Technical approach")
       - 401 vs 403 boundary; SESSION_STEP_UP_REQUIRED → 403 (deliberate divergence from RFC 9470's 401, justified in C2 prose)
       - ACCOUNT_LOCKED → 403 (per C7; with RFC 4918 §11.3 TODO marker)
   3.4 Adding a new error code (5-step checklist: enum, i18n EN, i18n JA, route usage, optional test)
       - **User-domain vocabulary rule**: code names use product-domain language (vault, passphrase, recovery, member, grant, session, ...), NOT internal implementation jargon (CEK, IV, auth tag, DPoP, AAD, body hash, escrow, refresh family, ...). Codes are exposed via dev tools, CLI output, SDKs, and OpenAPI spec — they are a permanent contract artifact. The principle is the same as `feedback_no_internal_jargon_in_user_strings.md` extended to error codes.
       - Note: codes returned on pre-auth / anonymous routes (e.g. share-link content access) should err toward generality; existing differentiation in SHARE_PASSWORD_* + NOT_FOUND(410) is grandfathered.
4. SCIM envelope (RFC 7644 — point at src/lib/scim/response.ts; do not duplicate spec)
5. OAuth/MCP envelope
   5.1 Authorization endpoint (RFC 6749 §4.1.2.1)
   5.2 Token + revoke endpoints (RFC 6749 §5.2; RFC 7009 §2.2)
   5.3 Device flow additions (RFC 8628 §3.5)
   5.4 Discovery metadata (RFC 8414) — informational only, not an error surface
   5.5 Extensions to RFC 6749 (list of deliberate deviations; currently: revoke 429 + `rate_limited` per C9)
6. JSON-RPC envelope (point at src/lib/mcp/server.ts)
7. Client consumption (Contract C3, with the verbatim comment from api-error-codes.ts:11-18)
8. Adding a new context field (decision tree: prefer a new code first; only add a context field when the same code applies to multiple resources with a per-instance datum)
9. Linting (the forbidden patterns from C1, C2, C3, C5, C6 as a single grep checklist; the `pre-pr.sh` integration via `scripts/checks/check-api-error-codes.sh` IS the CI gate per Non-functional req #2 — the earlier "not a CI gate" framing is corrected here. A future ESLint rule is tracked as TODO but not blocking.)
10. Migration notes (none — no breaking changes in this PR; C5 wire-byte-identical; C6 affects only admin audit-chain-verify and browser webauthn-register-verify)
```

**Acceptance**:
- File exists at `docs/api/error-handling.md`.
- Linked from `CLAUDE.md` "Architecture" section.
- All cross-references to `API_ERROR` codes resolve (no stale code names from before C5/C6).
- No personal-identifying data, RFC 1918 addresses, internal hostnames (RS4).

---

## Testing strategy

- **No new tests for documentation-only contracts** (C1, C3, C4, C7, C9, C10): documented behavior is verified by reading.
- **C5 — ACCESS_DENIED**:
  - Existing tests assert the wire string `"ACCESS_DENIED"` and continue to pass without modification (wire-byte-identical). Verified test sites (enumerate before merge): `src/__tests__/lib/access-restriction.test.ts:27,223,272`, `src/__tests__/proxy.test.ts:600,646,661`, `src/app/api/extension/token/refresh/route.test.ts:197`, `src/app/api/extension/token/route.test.ts:274`, `src/app/api/scim/v2/{ResourceTypes,Schemas,ServiceProviderConfig}/route.test.ts:50,53,56`, `src/app/api/tenant/access-requests/route.test.ts:366`, `src/app/api/vault/delegation/check/route.test.ts:112`, `src/lib/auth/session/check-auth.test.ts:204,229`, `src/lib/proxy/api-route.test.ts:210,227,250,272`. Total: ~16 assertion sites across ~12 test files.
  - Update `src/lib/http/api-error-codes.test.ts:121` count to reflect the new code (`+1` per new code added; final count depends on whether C6 also lands in the same PR — set to actual `Object.keys(API_ERROR).length` at PR creation time).
  - Add `accessDenied` to BOTH `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json` — `src/i18n/messages-consistency.test.ts:63` (the `it("keeps key sets aligned between locales per namespace", ...)` block) fails if either locale is missing the key. The diagnostic message there is generic ("Mismatch in namespace: ApiErrors") so reviewers MUST know to check this test.
  - Add a new dedicated coverage test at `src/__tests__/api-errors-i18n-coverage.test.ts` (mirroring the existing `audit-i18n-coverage.test.ts` pattern): for every value in `API_ERROR_I18N`, assert the i18n key is present in both `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json`. This closes the JSON-side gap that `satisfies Record<ApiErrorCode, string>` cannot catch (the TS map is exhaustive, but the JSON files are not type-checked against it). Cost: ~30 LOC, one-time. **NOTE for triangulate orchestrator**: this is a NEW test file the plan introduces; it is C5's responsibility because C5 is the first contract introducing new i18n keys.
- **C6 — Envelope violations and validation cleanup**:
  - **Update the existing assertion** at `src/app/api/webauthn/register/verify/route.test.ts` (the `it("returns 400 with VALIDATION_ERROR when challenge has expired", ...)` block, around line 413-422): change the assertion target from `"VALIDATION_ERROR"` to `"INVALID_CHALLENGE"` and update the test description string accordingly. Leave the two SIBLING `VALIDATION_ERROR` assertions in the same file (`verifyRegistration throws`, `verified === false`) unchanged.
  - **Update the mock** at `src/app/api/webauthn/register/verify/route.test.ts:91-99` `vi.mock("@/lib/http/api-error-codes", ...)`: add `INVALID_CHALLENGE: "INVALID_CHALLENGE"` to the curated subset.
  - **Audit-chain-verify**: ADD a new test (the existing `audit-chain-verify/route.test.ts` does not exercise the `fromSeq` seed-row branch at production `route.ts:201-205` — verified via grep for "fromSeq" / "seed" in the test file returns zero hits, and the existing mock hard-codes `mockQueryRawUnsafe.mockResolvedValue([])` which short-circuits before reaching the seed branch). The new test asserts both `status === 400` AND `body.error === "AUDIT_CHAIN_SEED_NOT_FOUND"` (use the literal string, NOT the `API_ERROR.AUDIT_CHAIN_SEED_NOT_FOUND` symbol — same rationale as the webauthn mock note: protects against mock-reality drift). The audit-chain-verify route does NOT currently mock `@/lib/http/api-error-codes`; the new test should NOT add such a mock (let the production module resolve normally so the new enum value is covered end-to-end).
  - Update `src/lib/http/api-error-codes.test.ts:121` count (combined with C5 — see C5 Testing strategy).
- **C8 — OpenAPI**:
  - Add an `it(...)` block inside the existing `describe("components.schemas", ...)` group at `src/lib/openapi-spec.test.ts` (verified at :100; nearest existing assertion is "ErrorResponse requires error field" at :156). The assertion is **set-equality**: `expect(new Set(enum)).toEqual(new Set(Object.values(API_ERROR)))` (order-independent, length-and-membership in one). This is meaningful when the implementation is `enum: Object.values(API_ERROR)` — it verifies the JSON-serialized spec round-trips correctly through `buildOpenApiSpec()`. The closure-direction subset assertion is intentionally NOT included because under the planned construction it is tautological; if a future refactor switches to a hand-curated enum array, the set-equality assertion still catches drift in both directions.
- **C9 — OAuth `"rate_limited"` (code comment + docs only)**: no new test. The comment+docs change is documentation-only; the wire is unchanged.
- **C5/C6 mock-drift check**: spot-check the 15+ test files that inline-mock `@/lib/http/api-error-codes` (use the same pattern as the webauthn site above). For each, verify the mock either re-exports the real module's surface OR includes every code the production code under test references. Out-of-scope for this plan to fix every drift — but `INVALID_CHALLENGE` MUST be in the webauthn mock specifically. A follow-up plan (not gated on this one) should introduce a shared `__fixtures__/api-error-codes.mock.ts` that re-exports the full `API_ERROR` enum so future drift becomes impossible.
- **No E2E impact** — the wire shape changes are byte-identical (C5) or affect only single error paths inside flows whose happy paths already have E2E coverage (C6's webauthn flow). For `INVALID_CHALLENGE` specifically, the expired-challenge timing window is hard to reproduce in Playwright (requires fake-timers manipulation in the browser); the unit test at the route handler is the correct coverage layer.

**Build verification**: `scripts/pre-pr.sh` MUST pass. This script bundles `npm run lint`, `npx vitest run`, `npx next build`, and ~11 project-specific static checks (`check-e2e-selectors`, `check-test-hygiene`, `check-env-docs`, `check-team-auth-rls`, `check-bypass-rls`, `check-crypto-domains`, `check-migration-drift`, no-deprecated-logAudit, fetch basePath compliance, secret scan, etc.). Running only `npm run lint && npx vitest run && npx next build` would bypass several CI gates per user-memory `feedback_run_pre_pr_before_push.md`.

**Optional grep-gate** (Non-functional req #2): add a 5-line `scripts/checks/check-api-error-codes.sh` that runs the C5 `ACCESS_DENIED` literal grep AND the C2 lowercase-leading + uppercase-with-whitespace patterns. Wire it into `pre-pr.sh` as `run_step "Static: api-error-codes" bash scripts/checks/check-api-error-codes.sh`. Cost: under 30 minutes; satisfies Non-functional req #2 ("MUST be enforceable by grep / ESLint pattern"). If this is deferred, mark in Considerations / risks with a TODO marker — leaving the grep gate undocumented violates Anti-Deferral Rules.

## User operation scenarios

These scenarios are deliberately short — this plan touches infrastructure, not user features. Validating "the user flow that triggers the error path" is sufficient.

1. **Access restriction trips (C5)**: a tenant has an IP allowlist; a user signs in from outside the allowlist. They receive 403 + `{ error: "ACCESS_DENIED" }`. The UI toast displays "Access denied." (en) / "アクセスが拒否されました。" (ja). No behavioral change from today; only the code path through `errorResponse()` is structurally cleaner.
2. **WebAuthn challenge replay (C6)**: a user submits a registration verify request with a stale challenge. They receive 400 + `{ error: "INVALID_CHALLENGE" }`. Today they receive 400 + `{ error: "VALIDATION_ERROR", details: "Challenge expired or already used" }`; the new code is more specific. UI: `apiErrorToI18nKey` returns `"invalidChallenge"` (new key) → generic translated copy "Security key registration could not be completed. Please retry." / "セキュリティキーの登録に失敗しました。もう一度お試しください。". The copy does NOT differentiate "expired" from "replayed" — both states are indistinguishable on the wire (the `redis.getdel` operation returns null in both cases), and revealing the distinction in the UI gives a session-takeover attacker the same info that was just removed from the wire.
3. **Vault lockout (C7, observation only)**: a user enters wrong passphrase 5+ times. They receive the same HTTP code and body as today — only the spec captures whichever status code is in effect.

## Considerations & constraints

### Known risks

1. **Out-of-tree consumers**: the SDK (`cli/`), iOS app, and browser extension all decode `{ error }` shapes today.
   - C5 (wire-string unchanged) — no consumer impact.
   - C6 (new codes `INVALID_CHALLENGE`, `AUDIT_CHAIN_SEED_NOT_FOUND`) — audit-chain-verify is admin-only and webauthn-register-verify is browser-only; neither is consumed by CLI/iOS/extension. Low risk. The C6 audit-chain-verify status change (422 → 400) is observable to admin operators via `scripts/purge-history.sh` and similar; their scripts read the body's `error` field, not the HTTP status, so the change is compatible.
   - **C11 (wire-string renames)** — IS observable to all out-of-tree consumers because the wire string changes. Affected surfaces: `MOBILE_*` codes are iOS-only; `EXTENSION_TOKEN_FAMILY_EXPIRED` is browser-extension-only; `LEGACY_*` and `KEY_ESCROW_NOT_COMPLETED` and `ATTACHMENT_CEK_MANIFEST_MISMATCH` and `INVALID_IV/AUTH_TAG_FORMAT` are all server-internal/browser-only with no CLI consumer. The iOS and extension teams MUST be notified of the renames before merge (or the PR ships them in coordination if those repos are in this monorepo — they are, under `cli/`, `extension/`, `ios/`). Pre-1.0 hard rename per user authorization.
2. **i18n key collision**: `"accessDenied"` (C5), `"invalidChallenge"` (C6), `"auditChainSeedNotFound"` (C6) are new keys. Two enforcement layers:
   - **Compile-time**: the `satisfies Record<ApiErrorCode, string>` constraint at `api-error-codes.ts:375` enforces every code has a TS-map entry.
   - **Runtime**: `src/i18n/messages-consistency.test.ts:62` enforces locale parity (en ↔ ja key sets equal per namespace). The new dedicated test `src/__tests__/api-errors-i18n-coverage.test.ts` (introduced under C5) closes the JSON-vs-TS-map gap.
3. **`unknownError` fallback divergence between locales**: the EA fallback is `"actionFailed"`, the general fallback is `"unknownError"`. C10 documents this divergence as intentional; no change.
4. **OpenAPI enum bloat**: adding all 149 codes (`147 + 3 − 1` after C5+C6+C11) to the OpenAPI enum (C8) increases spec size by a few KB. Negligible.
5. **Inline mock drift** (RT1): 15+ test files inline-mock `@/lib/http/api-error-codes` with curated subsets. C6's `INVALID_CHALLENGE` is explicitly added to the webauthn mock under C6 Acceptance. Other sites are not affected by this PR (none reference ACCESS_DENIED or the new codes in their mocked subset), but the structural risk remains. Follow-up plan should introduce a shared `__fixtures__/api-error-codes.mock.ts`.
6. **Future ESLint rule** (out of scope): a custom ESLint rule could enforce the forbidden patterns from C1/C2/C3/C5/C6 at lint time. The shell-script grep gate in `pre-pr.sh` (C8 Testing strategy) is the minimum-cost equivalent for this PR; ESLint rule tracked as a TODO in `docs/api/error-handling.md` § 9.
7. **Cache-Control on ACCESS_DENIED responses (per-site asymmetry)**: the proxy site at `src/lib/proxy/api-route.ts:111-117` sets `Cache-Control: no-store` today; the three `access-restriction.ts` sites do NOT. C5 preserves this asymmetry (see C5 Invariants). A future plan could harmonize by adding `no-store` to all four sites, but doing so in this PR would be a wire-additive change at three sites contradicting the "byte-identical" requirement.
8. **`currentKeyVersion` field on `CONFLICT` (Consumer D in C2)**: only one route emits this field (`webauthn/credentials/[id]/prf/route.ts:223`). The only known consumer is the route's own test file. If Phase 2 discovers no production consumer reads this field via `res.json()`, document in the deviation log and consider whether C4 should drop the field altogether (separate plan).
9. **`SESSION_STEP_UP_REQUIRED` is 403, RFC 9470 specifies 401**: deliberate divergence (see "401 vs 403" section). Our 403 + code-dispatch is intentional; the spec instructs clients to dispatch on the `error` code, not the HTTP status. Existing CLI/extension/UI handlers already follow this pattern.
10. **Anonymous-route enumeration**: codes like `SHARE_PASSWORD_INCORRECT`, `SHARE_PASSWORD_REQUIRED`, and `NOT_FOUND(410 vs revoked)` on share-link routes differentiate distinguishable failure modes for anonymous callers. The spec MUST advise authors of new pre-auth routes to err toward generality — but the existing codes are pre-existing behavior, not changed in this PR.

### Out-of-scope items (explicit, beyond the scope-decision items in Objective)

1. Refactoring the per-component overrides (`{ NOT_FOUND: "shareNotFound" }` etc.) into a centralized registry — current pattern is component-scoped and OK.
2. Adding server-side request IDs to error responses — observability concern, separate plan.
3. Restructuring the `EmergencyAccess` namespace to share more with `ApiErrors` — by design they have different copy.
4. Field-level error mapping on the client (Zod tree → form input errors) — already exists in some forms; not in this plan.
5. Audit log shape changes around `AUDIT_ACTION.ACCESS_DENIED` — separate from API error codes.

### Deviation log

(empty at plan creation; appended by Phase 2-4)

---

---

### C11 — Rename internal-jargon codes to user-domain vocabulary

**Decision** (user-confirmed): pre-1.0 hard rename, NO backward-compatibility aliases. The wire string changes for all renamed codes; all callers (server source, i18n maps, tests, CLI/extension/iOS consumers) update in lockstep within this PR.

**Rename table**:

| Current code | New code | Reason |
|--------------|----------|--------|
| `LEGACY_BODY_HASH_MISMATCH` | `LEGACY_INTEGRITY_MISMATCH` | "body hash" exposes HMAC implementation; "integrity" is the user-facing concept. |
| `ATTACHMENT_CEK_MANIFEST_MISMATCH` | `ATTACHMENT_KEY_MANIFEST_MISMATCH` | CEK (Content Encryption Key) is crypto-internal; "key" is the user concept. |
| `INVALID_IV_FORMAT` + `INVALID_AUTH_TAG_FORMAT` | `INVALID_ENCRYPTION_FORMAT` (single merged code) | IV (Initialization Vector) and AES-GCM auth tag are both AES-GCM-internal; collapse to one user-domain code. Both source codes mapped to the same i18n key (`invalidRequest`) already. |
| `MOBILE_DPOP_INVALID` | `MOBILE_TOKEN_BINDING_INVALID` | DPoP (RFC 9449) is unfamiliar; "token binding" is the user-domain effect. |
| `MOBILE_REFRESH_REPLAY_DETECTED` | `MOBILE_REFRESH_REUSE_DETECTED` | "replay" is security-domain; "reuse" reads as user-domain. |
| `MOBILE_REFRESH_FAMILY_EXPIRED` | `MOBILE_REFRESH_SESSION_EXPIRED` | "family" is OAuth rotation-internal; "session" is the user-facing concept. |
| `EXTENSION_TOKEN_FAMILY_EXPIRED` | `EXTENSION_TOKEN_SESSION_EXPIRED` | same reasoning as MOBILE_REFRESH_FAMILY_EXPIRED. |
| `LEGACY_ATTACHMENTS_RESIDUAL` | `ATTACHMENT_MIGRATION_INCOMPLETE` | "residual" is unclear; "migration incomplete" is plain. |
| `KEY_ESCROW_NOT_COMPLETED` | `EMERGENCY_RECOVERY_KEY_MISSING` | "key escrow" is a specialized legal/crypto term; "emergency recovery key" matches the Emergency Access UX vocabulary. |

Total: 10 source codes → 9 destination codes (net `-1` from the IV/AuthTag merge).

**Codes intentionally NOT renamed** (user-confirmed):
- `MOBILE_PKCE_MISMATCH` — PKCE is an OAuth industry-standard term; SDK / iOS dev consumers expect it.
- `MOBILE_DEVICE_PUBKEY_MISMATCH` — "pubkey" is borderline but DEVICE_PUBKEY conveys the user concept of "this device's identity".
- `ITEM_KEY_*`, `MEMBER_KEY_*`, `TEAM_KEY_*`, `KEY_NOT_DISTRIBUTED`, `KEY_ALREADY_DISTRIBUTED` — these refer to vault/team key concepts that ARE user-visible in the rotation UI.
- All other 130+ codes already user-domain.

**Invariants**:
- For each rename: update `API_ERROR` enum + `API_ERROR_I18N` map + `messages/en/ApiErrors.json` + `messages/ja/ApiErrors.json` + every production call site + every test asserting the old wire string. The TypeScript `satisfies Record<ApiErrorCode, string>` constraint guarantees the i18n map covers the new name (or compile fails).
- For the IV/AuthTag merge: production call sites that previously emitted EITHER code now emit `INVALID_ENCRYPTION_FORMAT`. The Phase 2 grep MUST identify all such sites (likely under `src/lib/crypto/` and attachment upload routes).
- New i18n keys: `legacyIntegrityMismatch`, `attachmentKeyManifestMismatch`, `invalidEncryptionFormat`, `mobileTokenBindingInvalid`, `mobileRefreshReuseDetected`, `mobileRefreshSessionExpired`, `extensionTokenSessionExpired`, `attachmentMigrationIncomplete`, `emergencyRecoveryKeyMissing` — both en and ja MUST be added. The retired i18n keys (`legacyBodyHashMismatch`, `attachmentCekManifestMismatch`, etc., from `API_ERROR_I18N` at api-error-codes.ts:248-330) are removed from both JSON files.
- No `@deprecated` alias is emitted; the wire string changes are immediate and load-bearing.

**Forbidden patterns**:
- `pattern: "LEGACY_BODY_HASH_MISMATCH"|"ATTACHMENT_CEK_MANIFEST_MISMATCH"|"INVALID_IV_FORMAT"|"INVALID_AUTH_TAG_FORMAT"|"MOBILE_DPOP_INVALID"|"MOBILE_REFRESH_REPLAY_DETECTED"|"MOBILE_REFRESH_FAMILY_EXPIRED"|"EXTENSION_TOKEN_FAMILY_EXPIRED"|"LEGACY_ATTACHMENTS_RESIDUAL"|"KEY_ESCROW_NOT_COMPLETED"` anywhere in `src/` (including tests). Reason: any survivor of the rename is a propagation bug.

**Acceptance**:
- `git grep -E '"(LEGACY_BODY_HASH_MISMATCH|ATTACHMENT_CEK_MANIFEST_MISMATCH|INVALID_IV_FORMAT|INVALID_AUTH_TAG_FORMAT|MOBILE_DPOP_INVALID|MOBILE_REFRESH_REPLAY_DETECTED|MOBILE_REFRESH_FAMILY_EXPIRED|EXTENSION_TOKEN_FAMILY_EXPIRED|LEGACY_ATTACHMENTS_RESIDUAL|KEY_ESCROW_NOT_COMPLETED)"' returns zero hits in `src/`.
- `git grep -E '\b(legacyBodyHashMismatch|attachmentCekManifestMismatch|invalidIvFormat|invalidAuthTagFormat|mobileDpopInvalid|mobileRefreshReplayDetected|mobileRefreshFamilyExpired|extensionTokenFamilyExpired|legacyAttachmentsResidual|keyEscrowNotCompleted)\b'` returns zero hits anywhere (camelCase i18n keys retired too).
- All previously-existing tests that asserted the old wire strings now assert the new wire strings (each affected test is updated in lockstep).
- `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json` each contain entries for all 9 new keys; the retired keys are removed from both. `messages-consistency.test.ts:63` continues to pass.
- `api-error-codes.test.ts:121` count is `149` (`147 - 1 from C11 merge + 3 from C5+C6`).
- The `__tests__` integration suites that may exercise the merged-or-renamed codes (e.g., `vault-rotate-key-attachments.integration.test.ts`, `mcp-oauth-flow.test.ts`, mobile-token integration tests) all pass.

**Anti-Deferral check**: rename pass is in-scope per user decision. No deferred TODOs.



| ID  | Subject                                                                | Status  |
|-----|------------------------------------------------------------------------|---------|
| C1  | Envelope identification rule (4 envelopes, OAuth split §4.1.2.1/§5.2)  | locked  |
| C2  | Main API error envelope shape (verified consumer walkthroughs)         | locked  |
| C3  | Client error consumption pattern                                       | locked  |
| C4  | Closed list of context fields (3 fields, ITEM_KEY_VERSION_DOWNGRADE removed) | locked  |
| C5  | ACCESS_DENIED gap fix (4 sites, applyCorsHeaders preserved)            | locked  |
| C6  | Envelope violations + validation cleanup (audit-chain-verify, INVALID_CHALLENGE) | locked  |
| C7  | ACCOUNT_LOCKED → 403 documentation (observation only)                  | locked  |
| C8  | OpenAPI error schema tightening (enum + closure assertions)            | locked  |
| C9  | OAuth `"rate_limited"` extension documentation (code comment + docs)   | locked  |
| C10 | docs/api/error-handling.md content outline (incl. user-domain vocab rule) | locked  |
| C11 | Rename internal-jargon codes to user-domain vocabulary (10 → 9, hard rename) | locked  |
| C12 | Migrate all main-API `NextResponse.json({error,status})` sites → `errorResponse()` | locked  |
| C13 | Add 5 missing `API_ERROR` codes for raw-string sites surfaced by C12; enable post-C12 grep gate | locked  |

Phase 2 cannot begin until every status reads `locked` and all plan-review rounds have closed.

---

### C13 — Add missing API_ERROR codes + enable post-C12 grep gate

**Decision** (user-confirmed during C12 verification): C12 surfaced 11 production sites using UPPER_SNAKE_CASE error codes that were NOT registered in the `API_ERROR` enum — raw string literals like `"INVALID_REQUEST"`, `"AUTHENTICATION_FAILED"`, `"SYNC_FAILED"`, `"KEY_VERSION_NOT_NEWER"`, `"BLOB_HASH_MISMATCH"`. These are C2 envelope violations (the value is not a member of `API_ERROR`). Add the missing codes, migrate the 11 sites to `errorResponse()`, and enable the post-C12 grep gate that forbids any future `NextResponse.json({ error: ... }, { status: ... })` in main-API routes.

**Sites covered**:

| Site | Raw code | New `API_ERROR` entry | Status |
|------|----------|----------------------|--------|
| `src/app/api/auth/passkey/verify/route.ts:50,60` | `"INVALID_REQUEST"` | `INVALID_REQUEST` | 400 |
| `src/app/api/auth/passkey/verify/route.ts:73,91` | `"AUTHENTICATION_FAILED"` | `AUTHENTICATION_FAILED` | 401 |
| `src/app/api/directory-sync/[id]/run/route.ts:107` | `"SYNC_FAILED"` | `SYNC_FAILED` | 500 |
| `src/app/api/passwords/[id]/history/[historyId]/route.ts:117` | `"KEY_VERSION_NOT_NEWER"` | `KEY_VERSION_NOT_NEWER` | 400 |
| `src/app/api/passwords/[id]/history/[historyId]/route.ts:126,146` | `"BLOB_HASH_MISMATCH"` | `BLOB_HASH_MISMATCH` | 409 |
| `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route.ts:129,138,165` | (same KEY/BLOB codes) | (shared with above) | 400 / 409 |

**Deliberate carve-outs** (NOT migrated):

| Site | Reason |
|------|--------|
| `src/app/api/maintenance/dcr-cleanup/route.ts:56` (`"endpoint_removed"`) | 410 Gone stub for deprecated endpoint — non-standard by design |
| `src/app/api/vault/delegation/check/route.ts` (`{authorized,reason}` envelope) | CLI consumer-specific shape, analogous to SCIM/OAuth envelope exclusions |
| `src/app/api/admin/rotate-master-key/route.ts` (free-form English) | Admin-only operator endpoint; operator scripts; design decision deferred |
| `src/app/api/mobile/.well-known/apple-app-site-association/route.ts` (free-form English) | Apple platform-mandated endpoint; non-API surface |

**Invariants**:
- New codes (`INVALID_REQUEST`, `AUTHENTICATION_FAILED`, `SYNC_FAILED`, `KEY_VERSION_NOT_NEWER`, `BLOB_HASH_MISMATCH`) added to `API_ERROR` AND `API_ERROR_I18N`.
- New i18n keys `invalidRequest_passkey` (or reuse existing `invalidRequest` — see below), `authenticationFailed`, `syncFailed`, `keyVersionNotNewer`, `blobHashMismatch` added to both en/ja `ApiErrors.json`.
- **`invalidRequest` collision**: an i18n key `invalidRequest` already exists in `ApiErrors.json` and is used by `INVALID_JSON`, `TOKEN_REQUIRED`, `INVALID_IV_FORMAT`/`INVALID_AUTH_TAG_FORMAT` (pre-C11), `INVALID_PREFIX`, `INVALID_CURSOR`, `INVALID_BODY`. The new `INVALID_REQUEST` code can REUSE this key (no duplicate JSON entry needed); only the TS map entry `INVALID_REQUEST: "invalidRequest"` is added. This avoids both creating a parallel key and the ambiguity of having two codes that map to the same UI copy.
- The 11 production sites switch from `NextResponse.json({error:"X"}, {status:N})` to `errorResponse(API_ERROR.X, N, [details if any])`.
- Test files keep their wire-string assertions (`expect(json.error).toBe("INVALID_REQUEST")` etc.) — the wire strings are unchanged.
- `api-error-codes.test.ts:121` count updates from `149` → `154` (+5).
- The grep gate `scripts/checks/check-api-error-codes.sh` gains a NEW rule: `NextResponse\.json\(\s*\{\s*error:` is forbidden in main-API routes (exclude `scim/`, `mcp/`, and the documented carve-outs). After C13, this gate runs clean.

**Acceptance**:
- `grep -RnE 'NextResponse\.json\(\s*\{\s*error:' src/app/api/ --include='*.ts' | grep -v '\.test\.' | grep -v '/__tests__/' | grep -v '/scim/' | grep -v '/mcp/'` returns ONLY the 4 documented carve-outs.
- `pre-pr.sh` passes all 17 checks (the existing api-error-codes gate now includes the new pattern).
- `Object.keys(API_ERROR).length === 154`.
- `npx vitest run` passes (~10237+ tests).

**Anti-Deferral**: in-scope per user authorization during C12 verification.


---

### C12 — Migrate all main-API error sites to `errorResponse()` helper

**Decision** (user-confirmed post Phase 2-1): the plan's minimum scope (C5/C6 site-level migration only) left ~139 production sites bypassing the `errorResponse()` helper despite emitting the canonical envelope shape. These sites are correct in wire output but the inconsistency means:
1. Future envelope-shape changes (e.g., adding `requestId`/`traceId`) require touching 139 sites instead of one helper.
2. Reviewers cannot pattern-spot "main-API error response" — three variants compete (`NextResponse.json` vs `errorResponse()` vs preset helpers like `unauthorized()`).
3. The grep gate cannot enforce a canonical pattern without first eliminating the legacy variant.

C12 closes this consistency gap.

**Signature**: convert every production site matching the pattern below to use `errorResponse()`.

| Current pattern | Target pattern |
|-----------------|----------------|
| `return NextResponse.json({ error: API_ERROR.XXX }, { status: N });` | `return errorResponse(API_ERROR.XXX, N);` |
| `return NextResponse.json({ error: API_ERROR.XXX, foo: "bar" }, { status: N });` | `return errorResponse(API_ERROR.XXX, N, { foo: "bar" });` |
| `return NextResponse.json({ error: API_ERROR.XXX }, { status: N, headers: { ... } });` | `return errorResponse(API_ERROR.XXX, N, undefined, { ... });` |

**Scope** (139 sites total, top files):

- `src/app/api/webauthn/register/verify/route.ts` (6)
- `src/app/api/vault/admin-reset/route.ts` (6)
- `src/app/api/teams/[teamId]/folders/[id]/route.ts` (6)
- `src/app/api/directory-sync/[id]/route.ts` (6)
- `src/app/api/vault/recovery-key/recover/route.ts` (5)
- `src/app/api/v1/passwords/route.ts` (5)
- `src/app/api/tenant/members/[userId]/route.ts` (5)
- ... ~109 additional sites across `src/app/api/{auth,teams,tenant,passwords,folders,notifications,sessions,extension,share-links,sends,emergency-access,travel-mode,api-keys,user,maintenance,vault,audit-logs}/**/*.ts`

**Excluded** (envelope-specific, preserve current code):

- `src/app/api/scim/v2/**` — RFC 7644 envelope via `scimError()`.
- `src/app/api/mcp/**` — RFC 6749 envelope (inline) and RFC 8628 device flow.
- Helper definitions themselves (`src/lib/http/api-response.ts:errorResponse` etc.).

**Invariants**:
- Wire output MUST remain byte-identical for every migrated site. `errorResponse()` produces `{ error, ...details }` when details is provided, `{ error }` when it isn't — matching the spread shape used at the call sites today.
- Headers passed via the 4th argument MUST land in the response unchanged (verify `errorResponse` signature handles this correctly at `src/lib/http/api-response.ts:27-37`).
- `NextResponse` import is removed from migrated files ONLY when no remaining `NextResponse.*` use exists (e.g., success-path `NextResponse.json(data)` calls or type annotations like `Promise<NextResponse>`). Leave the import alone if any other use remains.

**Forbidden patterns** (enforced via `scripts/checks/check-api-error-codes.sh` after C12):
- `pattern: NextResponse\.json\(\s*\{\s*error:` outside `src/app/api/scim/`, `src/app/api/mcp/`, and helper files — reason: the canonical error envelope MUST go through `errorResponse()`. Existing patterns for OAuth/SCIM stay as-is.

**Acceptance**:
- After C12 + grep-gate update, running `grep -RnE 'NextResponse\.json\(\s*\{\s*error:' src/app/api/ --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | grep -v '/__tests__/' | grep -v '/scim/' | grep -v '/mcp/'` returns ZERO hits.
- `npx vitest run` passes the full suite. No test assertions need updating — all assertions read `body.error` (the wire string) which is unchanged.
- `pre-pr.sh` passes all 18 checks (17 + the C12-extended grep gate).

**Anti-Deferral**: in-scope per user authorization post Phase 2-1.

