# API Error Handling

## 1. Overview

passwd-sso exposes four distinct error envelopes across its API surface — one
per protocol family (Main API, SCIM, OAuth/MCP, JSON-RPC). Errors are
identified by the combination of the **HTTP status code** (broad class, for
generic HTTP clients, browser dev tools, log aggregators, and CDN policies)
AND a **machine-readable `error` code** in the body (specific reason, stable
across spec revisions, used for client branching and i18n translation). The
two are used **together**, not either-or: the HTTP code lets infrastructure
react; the body code lets the application react.

The envelope a route returns is determined mechanically from its path prefix
(see §2). The four envelopes do not mix — emitting an OAuth-style error from
a `/api/passwords/*` route, or a SCIM envelope from a non-SCIM route, is a
forbidden pattern.

## 2. Envelope identification rule

The route prefix determines the envelope. This is mechanical, not interpretive:

| Route prefix | Envelope | Codes | Source of truth |
|--------------|----------|-------|-----------------|
| `/api/scim/v2/*` | RFC 7644 SCIM Error | `urn:ietf:params:scim:api:messages:2.0:Error` | `src/lib/scim/response.ts` (`scimError()`) |
| `/api/mcp/authorize`, `/api/mcp/authorize/consent` | RFC 6749 OAuth Error (authorization endpoint) | `invalid_request`, `unauthorized_client`, `access_denied`, `unsupported_response_type`, `invalid_scope`, `server_error`, `temporarily_unavailable` per RFC 6749 §4.1.2.1 | inlined per route |
| `/api/mcp/token`, `/api/mcp/revoke`, `/api/mcp/register` | RFC 6749 OAuth Error (token endpoint) | `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope` per RFC 6749 §5.2; device-flow additions `slow_down`, `authorization_pending`, `expired_token` per RFC 8628 §3.5 | inlined per route |
| `/api/mcp/.well-known/oauth-authorization-server` | RFC 8414 discovery metadata (informational, not an error surface in normal use; 404 if missing) | n/a | inlined |
| `/api/mcp` (POST JSON-RPC body) | JSON-RPC 2.0 Error | numeric `code` (`-32700` / `-32600` / `-32601` / `-32602` / `-32603` / `-32000`..`-32099`) | `src/lib/mcp/server.ts` |
| All other `/api/*` | Main API Error | `API_ERROR` enum (TypeScript) | `src/lib/http/api-error-codes.ts` |

Cross-envelope wrapping (e.g., a `{ error_description: ... }` OAuth-style body
emitted from a non-OAuth route) is a forbidden pattern — see §9 (Linting).

## 3. Main API envelope

This is the dominant case. Every route under `/api/*` that is not SCIM /
OAuth-MCP / JSON-RPC uses this envelope.

### 3.1 Wire shape

```typescript
type MainApiErrorBody =
  | { error: ApiErrorCode }
  | { error: ApiErrorCode; details: unknown }
  | ({ error: ApiErrorCode } & ContextField);

type ContextField =
  | { lockedUntil: string | null }       // with ACCOUNT_LOCKED only
  | { currentKeyVersion: number };       // with CONFLICT only (webauthn PRF CAS path)
// Note: RATE_LIMIT_EXCEEDED has NO body context field — `Retry-After` header
// carries the wait duration.
```

Invariants:

- The wire shape is always JSON with `Content-Type: application/json`.
- `error` is always a member of `API_ERROR` (typed `ApiErrorCode`) and matches
  the regex `^[A-Z][A-Z0-9_]+$` (UPPER_SNAKE_CASE).
- `details` is only present on `VALIDATION_ERROR` and contains the
  `z.treeifyError(...)` output (object tree shape, never a plain string).
- `lockedUntil` is always present on `ACCOUNT_LOCKED` responses, even when
  null — consumers parse `null` as "no known expiry".
- `RATE_LIMIT_EXCEEDED` responses include the `Retry-After` header (seconds,
  ceiling-rounded). No body context field.
- Any body context field other than `details`, `lockedUntil`, or
  `currentKeyVersion` is forbidden until this contract is amended (see §8).

Examples:

```json
{ "error": "UNAUTHORIZED" }
```

```json
{
  "error": "VALIDATION_ERROR",
  "details": {
    "errors": [],
    "properties": {
      "email": { "errors": ["Invalid email"] }
    }
  }
}
```

```json
{ "error": "ACCOUNT_LOCKED", "lockedUntil": "2026-05-13T15:00:00.000Z" }
```

```json
{ "error": "ACCOUNT_LOCKED", "lockedUntil": null }
```

```json
{ "error": "CONFLICT", "currentKeyVersion": 3 }
```

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{ "error": "RATE_LIMIT_EXCEEDED" }
```

The helper at `src/lib/http/api-response.ts` (`errorResponse`,
`unauthorized`, `notFound`, `forbidden`, `validationError`,
`zodValidationError`, `rateLimited`) produces these shapes. New routes MUST
use the helpers; direct `NextResponse.json({ error: ... }, { status })` calls
are linted out.

### 3.2 Context fields

There are exactly three body context fields permitted today, plus one HTTP
response header:

| Field | Type | Pairs with | Source |
|-------|------|-----------|--------|
| `details` | `unknown` (tree from `z.treeifyError()`) | `VALIDATION_ERROR` | `validationError()` / `zodValidationError()` |
| `lockedUntil` | `string \| null` (ISO 8601) | `ACCOUNT_LOCKED` | `vault/unlock` (2 sites), `travel-mode/disable` |
| `currentKeyVersion` | `number` | `CONFLICT` | `webauthn/credentials/[id]/prf` only |
| `Retry-After` (HTTP header) | seconds (integer) | `RATE_LIMIT_EXCEEDED` | `rateLimited()` |

Adding a new body context field requires:

1. Justification (why a separate error code does not suffice — see §8).
2. Update of this section.
3. TypeScript type added to the `ContextField` union so the type system enforces it.

### 3.3 HTTP status code semantics

HTTP status codes are used together with the `error` code. The HTTP code is
the broad class; the `error` code is the specific reason.

| HTTP | When | Example codes |
|------|------|---------------|
| 400 | Malformed input — request cannot be parsed or fails Zod validation | `INVALID_JSON`, `VALIDATION_ERROR`, `INVALID_CURSOR`, `INVALID_PREFIX`, `INVALID_BODY` |
| 401 | No identity — caller did not authenticate, or session/token is invalid/expired | `UNAUTHORIZED`, `INVALID_SESSION`, `API_KEY_INVALID`, all `MOBILE_*` |
| 403 | Identity OK, permission insufficient — role, scope, tenancy, recency, or origin restriction denies access | `FORBIDDEN`, `FORBIDDEN_INSUFFICIENT_ROLE`, `ACCESS_DENIED`, `SESSION_STEP_UP_REQUIRED`, `*_SCOPE_INSUFFICIENT`, `OWNER_ONLY`, `ONLY_OWN_ENTRIES`, `NOT_AUTHORIZED_FOR_GRANT`, `ACCOUNT_LOCKED` |
| 404 | Resource does not exist in this caller's scope | `NOT_FOUND`, `USER_NOT_FOUND`, `TEAM_NOT_FOUND`, `*_NOT_FOUND` family |
| 409 | Request conflicts with current resource state | `CONFLICT`, `VAULT_ALREADY_SETUP`, `*_ALREADY_EXISTS`, `*_ALREADY_REVOKED`, `ALREADY_A_MEMBER`, `SLUG_ALREADY_TAKEN` |
| 410 | Endpoint deprecated and removed | (deprecated route stubs) |
| 413 | Body exceeds size limit | `PAYLOAD_TOO_LARGE`, `FILE_TOO_LARGE`, `SEND_FILE_TOO_LARGE` |
| 422 | Semantic validation of well-formed input failed (rare) | reserved; see below |
| 429 | Rate limit exceeded | `RATE_LIMIT_EXCEEDED` |
| 500 | Server-side bug — unexpected failure | `INTERNAL_ERROR` |
| 503 | Downstream dependency unavailable (Redis, WebAuthn, HIBP, etc.) | `SERVICE_UNAVAILABLE`, `UPSTREAM_ERROR` |

#### 400 vs 422

Use **400 for all input-shape failures** (parse errors, Zod validation,
missing fields, wrong types). Reserve **422** for cases where the body parses,
Zod accepts it, but a multi-field semantic invariant fails (e.g.,
`startDate > endDate` when both fields individually validate). In practice
this codebase has no 422 sites after C6 — every prior 422 was a 400 in
disguise.

#### 401 vs 403

The boundary is whether the server knows who is making the request AND trusts
that identity for THIS action:

- No identity (no cookie/token, or token invalid/expired) → 401
- Identity present, action denied (wrong role, missing scope, tenant
  restriction, origin mismatch, OR session too old for high-assurance
  action) → 403

`SESSION_STEP_UP_REQUIRED` is **403** in this codebase (see
`src/lib/auth/session/step-up.ts` and
`src/lib/auth/webauthn/recent-passkey-verification.ts`). Rationale: the
caller's identity is established and still valid for low-assurance actions;
the server is refusing THIS specific action because the session is older
than the step-up window. This is closer to "permission insufficient for the
required assurance level" (403) than "no identity" (401).

**Deliberate divergence from RFC 9470**: RFC 9470 (OAuth 2.0 Step Up
Authentication Challenge Protocol) §3 specifies **401 Unauthorized +
`WWW-Authenticate: insufficient_user_authentication`** for step-up. Our use
of 403 + a body code is intentional and is NOT planned to migrate. Two
reasons:

1. The header-based RFC 9470 contract requires client-side
   `WWW-Authenticate` parsing across CLI / iOS / extension surfaces — out of
   scope for the minimum-cost path here.
2. Our existing CLI / extension / UI handlers already dispatch on
   `error === "SESSION_STEP_UP_REQUIRED"` (see
   `src/components/settings/developer/*.tsx`,
   `src/hooks/auth/use-inline-reauth.ts`). A status-only switch to 401 would
   invite naïve "session expired → re-login at AAL1" handling that defeats
   the step-up requirement.

**Clients receiving `SESSION_STEP_UP_REQUIRED` MUST dispatch on the `error`
code, NOT the HTTP status — the code is the stable contract.**

#### ACCOUNT_LOCKED → 403

`ACCOUNT_LOCKED` is **403** at all 3 sites
(`src/app/api/vault/unlock/route.ts` lines 47-48 and 105-107,
`src/app/api/travel-mode/disable/route.ts` lines 36-37). Rationale:
"lockout-as-authorization-denial" — the server has the caller's identity but
refuses the action for a time-bounded reason.

`TODO(account-locked-423)`: RFC 4918 §11.3 defines **423 Locked**, which is
semantically more precise than 403 for time-bounded locks. Migration is
deferred because it is a wire-shape change visible to existing clients (CLI,
extension, iOS would all need updating to interpret 423). When the migration
runs, it must coordinate across all consuming surfaces.

### 3.4 Adding a new error code

Five steps:

1. Add the code to `API_ERROR` in `src/lib/http/api-error-codes.ts`.
2. Add the i18n key mapping to `API_ERROR_I18N` in the same file. The
   `satisfies Record<ApiErrorCode, string>` constraint enforces presence at
   compile time.
3. Add the English copy to `messages/en/ApiErrors.json`.
4. Add the Japanese copy to `messages/ja/ApiErrors.json`. `src/i18n/messages-consistency.test.ts`
   enforces locale parity per namespace; both locales MUST be updated in
   lockstep.
5. Use `errorResponse(API_ERROR.YOUR_NEW_CODE, <status>)` at the route. If a
   test asserts the wire string, update it.

**User-domain vocabulary rule**: code names use product-domain language
(vault, passphrase, recovery, member, grant, session, team, attachment, ...),
NOT internal implementation jargon. Forbidden in new names:

- Cryptography internals: CEK (Content Encryption Key), IV, auth tag, AAD,
  body hash, escrow, key derivation function, salt.
- OAuth rotation internals: DPoP, refresh family, refresh chain.

Codes are exposed via dev tools, CLI output, SDKs, and the public OpenAPI
spec — they are a permanent contract artifact. The principle is the same as
the user-strings rule in `~/.claude/rules/`, extended to error codes.

**Anonymous-route enumeration note**: codes returned on pre-auth /
anonymous routes (e.g., share-link content access) should err toward
generality — distinguishing too many failure modes for an anonymous caller
leaks information that helps an attacker enumerate state. The existing
differentiation in the `SHARE_PASSWORD_*` family plus `NOT_FOUND` at status
410 for revoked links is grandfathered behavior. New pre-auth routes should
prefer a single generic code over multiple specific ones.

## 4. SCIM envelope (RFC 7644)

SCIM 2.0 routes under `/api/scim/v2/*` use the RFC 7644 §3.12 SCIM Error
schema. Source of truth: `src/lib/scim/response.ts` (`scimError`).

Wire shape:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "409",
  "scimType": "uniqueness",
  "detail": "User already exists"
}
```

The `Content-Type` is `application/scim+json`. Do not duplicate the spec
here — refer to RFC 7644 §3.12 and the SCIM helper signature directly.

## 5. OAuth/MCP envelope

The OAuth-style envelope is used at every route under `/api/mcp/{authorize,
authorize/consent, token, revoke, register}`. The wire shape is
`{ error: <snake_case_code>, error_description?: <string>, error_uri?: <string> }`
per RFC 6749, and `Content-Type` is `application/json`.

### 5.1 Authorization endpoint (RFC 6749 §4.1.2.1)

`/api/mcp/authorize` and `/api/mcp/authorize/consent` MAY return one of:

- `invalid_request`
- `unauthorized_client`
- `access_denied`
- `unsupported_response_type`
- `invalid_scope`
- `server_error`
- `temporarily_unavailable`

Error responses are typically delivered as redirects with the `error` and
`error_description` query parameters appended to the registered redirect URI
(per RFC 6749 §4.1.2.1) — the JSON body shape is used only when the redirect
URI itself cannot be resolved.

### 5.2 Token + revoke endpoints (RFC 6749 §5.2; RFC 7009 §2.2)

`/api/mcp/token`, `/api/mcp/revoke`, and `/api/mcp/register` MAY return one
of (RFC 6749 §5.2):

- `invalid_request`
- `invalid_client`
- `invalid_grant`
- `unauthorized_client`
- `unsupported_grant_type`
- `invalid_scope`

Per RFC 7009 §2.2, the revoke endpoint normally returns **200** for any
outcome (including unknown tokens). Our extension to this rule is documented
in §5.5.

### 5.3 Device flow additions (RFC 8628 §3.5)

The device authorization grant adds three codes:

- `slow_down`
- `authorization_pending`
- `expired_token`

These apply only to the device flow polling endpoint and are not used at
revoke / register.

### 5.4 Discovery metadata (RFC 8414)

`/api/mcp/.well-known/oauth-authorization-server` is informational and not
an error surface in normal operation. It returns 200 with the discovery
document, or 404 if the document is not configured. No OAuth error envelope
is emitted from this route.

### 5.5 Extensions to RFC 6749

We deliberately extend the spec in one place:

- **`/api/mcp/revoke` returns 429 + `{ error: "rate_limited" }` for abuse
  mitigation.** This deviates from RFC 7009 §2.2's "always 200" rule and
  uses an error code (`rate_limited`) that is not defined by RFC 6749 §5.2.
  The deviation is intentional: returning 200 to a rate-limited caller
  removes the only signal an honest client has to back off, and silently
  draining the rate-limit budget on every request encourages abuse. The
  inline `Retry-After` header carries the wait duration. Source: see the
  code comment at `src/app/api/mcp/revoke/route.ts` immediately above the
  rate-limit response.

Any future deviation MUST be added to this list with its own justification
before it ships.

## 6. JSON-RPC envelope

The single MCP gateway endpoint at `/api/mcp` (POST with a JSON-RPC 2.0
body) uses the JSON-RPC error object per the spec:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32602, "message": "Invalid params" }
}
```

Codes are the standard JSON-RPC integers:

- `-32700` Parse error
- `-32600` Invalid Request
- `-32601` Method not found
- `-32602` Invalid params
- `-32603` Internal error
- `-32000` to `-32099` server-defined errors

Source of truth: `src/lib/mcp/server.ts`. Do not introduce new server-defined
codes outside that module.

## 7. Client consumption

The client-side contract is the same across every consumer: read the body's
`error` field, run it through the relevant translator, look up the
translation in the matching namespace.

The canonical block from `src/lib/http/api-error-codes.ts` (top-of-file
JSDoc) is reproduced here:

> Centralized error codes for ALL API routes (including Emergency Access).
> Imported by both server (API routes) and client (components).
>
> ### Server side (API routes)
>
> - Always return `{ error: API_ERROR.XXX }` — never raw English strings.
> - For Zod validation failures: `zodValidationError(parsed.error)` from `@/lib/api-response`
>
> ### Client side (components)
>
> - **EA UI** (grant-card, create-grant-dialog, invite/[token], [id]/vault):
>   → `t(eaErrorToI18nKey(err?.error))` with `useTranslations("EmergencyAccess")`
> - **Everything else**:
>   → `tApi(apiErrorToI18nKey(err?.error))` with `useTranslations("ApiErrors")`
> - If a specific domain needs overrides (e.g. `NOT_FOUND` → "shareNotFound"),
>   pass `overrides` to `apiErrorToI18nKey(err?.error, { NOT_FOUND: "shareNotFound" })`.

Practical signatures:

```typescript
function apiErrorToI18nKey(
  error: unknown,
  overrides?: Partial<Record<ApiErrorCode, string>>,
): string;

function eaErrorToI18nKey(error: unknown): string;
```

The default fallback is `"unknownError"` for `apiErrorToI18nKey` and
`"actionFailed"` for `eaErrorToI18nKey`. The fallback is opaque to the user
("An error occurred") and MUST NOT leak the raw code value to the UI.

Domain overrides go through the `overrides` parameter — manually constructed
switch statements on the error code in component code are a forbidden pattern
(see §9). The server returns codes only; the client translates.

### Typed body access (`readApiErrorBody` + `getApiErrorMessage` / `getApiErrorDetail`)

When a UI consumer needs to read **body fields** (not just the HTTP status), use
the typed helpers from `@/lib/http/read-api-error-body`:

- `readApiErrorBody(res)` → `MainApiErrorBody | null` — typed envelope. Accessing
  `body.message` or any other non-listed key is a TypeScript compile error
  (the closed list is `error`, `details`, `lockedUntil`, `currentKeyVersion`).
- `getApiErrorMessage(body)` → the inner `details.message` string (or `null`).
- `getApiErrorDetail(body, field, guard)` → a single field from `details` with
  a runtime type guard.

```ts
import { fetchApi } from "@/lib/url-helpers";
import {
  readApiErrorBody,
  getApiErrorMessage,
  getApiErrorDetail,
} from "@/lib/http/read-api-error-body";

const res = await fetchApi("/api/tenant/policy", {
  method: "PATCH",
  body: JSON.stringify(policy),
});

if (!res.ok) {
  const detail = getApiErrorMessage(await readApiErrorBody(res));
  toast.error(detail ?? t("genericFailure"));
  return;
}

// Or for a non-`message` field:
const body = await readApiErrorBody(res);
const aborted = getApiErrorDetail(body, "abortedSafety", (v): v is true => v === true);
```

This is the compile-time guard that prevents F8-class regressions
(UI reading a top-level field that the server moved into `details`). Existing
code that does `await res.json()` directly remains valid but loses the type
safety; new code SHOULD prefer the helpers.

### Server-side: `errorResponseWithMessage` for `{ details: { message } }`

Server-side, the equivalent wrap is canonicalized through
`errorResponseWithMessage(code, status, message)` in
`@/lib/http/api-response`. Replaces the verbose form
`errorResponse(CODE, STATUS, { details: { message: "..." } })` at ~33 production
sites and keeps the wrap-shape in one helper:

```ts
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponseWithMessage } from "@/lib/http/api-response";

return errorResponseWithMessage(
  API_ERROR.VALIDATION_ERROR,
  400,
  `Maximum ${MAX_CIDRS} CIDRs allowed`,
);
```

For Zod / multi-field validation errors, use `validationError(treeOrObject)`
directly (it takes `Record<string, unknown>` — strings would be a TypeScript
compile error per the C6 invariant).

## 8. Adding a new context field

Body context fields are deliberately scarce. Before adding one:

1. **Prefer a new error code over a new context field.** If the new datum
   distinguishes one failure mode from another, introduce a code that names
   the mode. This keeps the code-to-meaning mapping single-purpose.
2. **Only add a context field when the same code applies to multiple
   resources with a per-instance datum.** Example: `ACCOUNT_LOCKED` pairs
   with `lockedUntil` because the same code is emitted at multiple sites and
   each site has a different lock expiry timestamp — splitting into
   per-site codes would not help the consumer (the UI message is the same;
   only the countdown differs).
3. **Never add a context field for one-off cases.** `currentKeyVersion` on
   `CONFLICT` is borderline; it exists because the webauthn PRF CAS path
   needs to communicate the current version to the client retry logic. If
   this field has no production consumer outside its route's own tests, a
   future cleanup may remove it.
4. **Update §3.2 in the same PR.** Adding a field without updating the
   closed list is a contract drift bug.
5. **Add the TypeScript type** to the `ContextField` union so the compiler
   enforces it at the helper-input boundary.

## 9. Linting

The following patterns are forbidden and caught by a `grep`-based static
check. The check lives at `scripts/checks/check-api-error-codes.sh` and is
wired into `scripts/pre-pr.sh` — running `scripts/pre-pr.sh` before opening a
PR is the local CI gate per Non-functional req #2.

Grep patterns (forbidden):

| Pattern | Reason |
|---------|--------|
| `NextResponse\.json\(\s*\{\s*error:\s*"[a-z]` outside `src/app/api/scim/` and `src/app/api/mcp/{authorize,authorize/consent,token,revoke,register}` | Enforces UPPER_SNAKE_CASE for Main API codes; catches snake_case OAuth-style leakage into main-API routes |
| `NextResponse\.json\(\s*\{\s*error:\s*"[A-Z][^"]*\s` outside `src/app/api/scim/` and `src/app/api/mcp/` | Catches English-prose strings used as `error` value |
| `NextResponse\.json\(\s*\{\s*message:` outside `src/app/api/mcp/` | Catches accidental Java-style `{ message, error }` shape |
| `NextResponse\.json\(\s*\{\s*error:\s*"ACCESS_DENIED"` outside `__tests__/` and `*.test.ts` | Catches future copy-paste of the old string-literal form (production code MUST go through `errorResponse(API_ERROR.ACCESS_DENIED, ...)`) |
| `API_ERROR\.VALIDATION_ERROR.*details:\s*"` | String-typed `details`; consumers expect a tree object |
| `error_description` outside `/api/mcp/{authorize,authorize/consent,token,revoke,register}` | OAuth envelope must not leak into non-OAuth routes |
| `schemas":\s*\[\s*"urn:ietf:params:scim` outside `src/lib/scim/` | SCIM envelope must not leak into non-SCIM routes |
| `jsonrpc:\s*"2\.0"` outside `src/lib/mcp/` and `src/app/api/mcp/route.ts` | JSON-RPC envelope must not leak into other routes |
| `switch.*err.*case ["']` in `src/components/` (allow-list: `eaErrorToI18nKey`) | Catches manual switch-on-error-code that bypasses `apiErrorToI18nKey` |

**TODO**: a custom ESLint rule could enforce the above at lint time with
better filename allow-listing. The shell-script grep gate is the
minimum-cost equivalent today.

## 10. Migration notes

No breaking wire-shape changes for the browser web app in this release.

Out-of-tree consumers in the monorepo that DO observe wire-string renames:

- **iOS app** — affected by the `MOBILE_*` renames
  (`MOBILE_DPOP_INVALID` → `MOBILE_TOKEN_BINDING_INVALID`,
  `MOBILE_REFRESH_REPLAY_DETECTED` → `MOBILE_REFRESH_REUSE_DETECTED`,
  `MOBILE_REFRESH_FAMILY_EXPIRED` → `MOBILE_REFRESH_SESSION_EXPIRED`).
- **Browser extension** — affected by
  `EXTENSION_TOKEN_FAMILY_EXPIRED` → `EXTENSION_TOKEN_SESSION_EXPIRED`.
- **Admin audit-chain-verify endpoint** — the `error` value changes from a
  raw English prose template to `AUDIT_CHAIN_SEED_NOT_FOUND`, and the HTTP
  status changes from 422 to 400. Operator scripts that branch on the body
  `error` field are compatible; scripts that branch on the HTTP status need
  updating.

All three consumers ship in this monorepo (under `ios/`, `extension/`, and
`scripts/`) and the renames land in lockstep with the server change. There
is no transitional alias period — the pre-1.0 hard-rename was explicitly
authorized.
