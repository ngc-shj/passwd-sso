# Auth Surface + Token Type Matrix

This document maps every authentication mechanism in the system to the route
surfaces that accept it, and then details every distinct token/credential type:
issuance, validation, TTL, rotation, revocation, and hash-at-rest storage.
Grounded in `scripts/checks/route-policy-manifest.json` (C1) `auth` fields,
`docs/architecture/machine-identity.md`, and `src/lib/proxy/route-policy.ts`
(`classifyRoute` / `ROUTE_POLICY_KIND`).

---

## Auth surface grid

`classifyRoute()` (`src/lib/proxy/route-policy.ts:112-176`) assigns a pathname
one of 9 `ROUTE_POLICY_KIND` values; the manifest's `auth` field records which
mechanism(s) a given route's handler actually accepts. As of this writing the
manifest's `auth` vocabulary contains 16 distinct values across 212 routes:

| Auth mechanism | Route-policy kind(s) that carry it | Notes |
| --- | --- | --- |
| `session` | `api-session-required` (the vast majority of `/api/passwords`, `/api/tags`, `/api/teams`, `/api/tenant`, `/api/vault`, `/api/folders`, `/api/webauthn`, etc.) | Auth.js database session cookie; validated by the proxy's `auth-gate.ts` before the route handler runs. |
| `extension-token` | `api-session-required` (Bearer-bypass-eligible subset), `api-extension-exchange` | Alternative auth on `Bearer`-bypass routes (`isBearerBypassRoute` in `cors-gate.ts`); the route itself still fundamentally classifies as session-required. |
| `bridge-code` | `api-extension-bridge-code` | One-time code exchanged for a Bearer token; issuance is session-gated, exchange is cookieless. |
| `mobile-bearer-token` | `api-default` (`/api/mobile/*`) | iOS app's Bearer token; the route self-enforces auth (proxy does not session-gate `/api/mobile/*` — see `SESSION_REQUIRED_EXACT_PATHS` comment in `route-policy.ts:83-89`). |
| `dpop` | (cross-cutting, not a `classifyRoute` kind) | DPoP proof-of-possession binding layered on top of `extension-token` / `mobile-bearer-token` validation, not a standalone route kind. |
| `api-key` | `api-v1` (`/api/v1/*`) | REST API v1 is exclusively `api_`-prefixed Bearer; no session/cookie path. |
| `service-account-token` | `api-v1`, `api-default` (JIT `access-requests`) | `sa_`-prefixed Bearer; MCP Gateway and v1 REST both accept it. |
| `mcp-token` | `api-default` (`/api/mcp/*` except OAuth endpoints) | `mcp_`-prefixed Bearer, minted by the OAuth 2.1 exchange. |
| `mcp-client-credential` | `api-default` (`/api/mcp/token` client-credential grant path) | OAuth 2.1 client `client_id`/`client_secret`, not a Bearer token. |
| `operator-token` | `api-default` (`/api/maintenance/*`, `/api/admin/rotate-master-key/**`) | `op_`-prefixed Bearer, validated by `verifyAdminToken`; never dispatched through `authOrToken()` — see "Central dispatcher" below. |
| `scim-bearer` | `api-default` (`/api/scim/v2/*`) | `scim_`-prefixed Bearer, tenant-scoped. |
| `pre-auth` | `api-default` (`/api/auth/[...nextauth]`, passkey `options`/`options/email`) | No auth by definition — these routes establish or challenge for auth; defended by Origin checks / rate limiting / timing-safe dummy paths, not token/session auth. |
| `share-token` | `public-share` (`/api/share-links/[id]/content`) | Opaque per-share token in the URL path; no session, no Bearer. |
| `share-verify-token` | `public-share` (`/api/share-links/verify-access`) | Same class, verify-only endpoint. |
| `none` | `public-receiver` (`/api/csp-report`), select `api-default` pre-auth routes | Deliberately unauthenticated; `handlerAuthReason` in the manifest documents why for each. |
| `none-410-stub` | `api-default` (`/api/admin/rotate-master-key/route.ts`, the legacy single-actor endpoint) | No auth by design — the route is a 410 Gone stub; "the 410 itself is the answer." |

For the full per-route breakdown (kind, methods, bearer-bypass eligibility,
destructive/side-effecting-GET/operator-gated flags, and the reviewed
`handlerAuthReason` prose), see the generated
[`route-policy-matrix.md`](route-policy-matrix.md), which renders every one of
the 212 entries from the same manifest this grid summarizes.

### Central dispatcher

`authOrToken()` (`src/lib/auth/session/auth-or-token.ts:62-153`) is the shared
entry point most non-proxy-gated routes use. Dispatch order:

1. Auth.js session (`auth()`) — checked first; full access, no scope narrowing.
2. Bearer prefix table (`KNOWN_PREFIXES = [API_KEY_PREFIX, SA_TOKEN_PREFIX, MCP_TOKEN_PREFIX, SCIM_TOKEN_PREFIX]`,
   i.e. `api_`, `sa_`, `mcp_`, `scim_`):
   - `api_` → `validateApiKey()`
   - `sa_` → `validateServiceAccountToken()`
   - `mcp_` → `validateMcpToken()`
   - any other recognized-but-unhandled-here prefix → rejected (does not fall through to extension-token)
3. No recognized prefix → assumed opaque extension token → `validateExtensionToken()`.

`op_` (operator token) is **deliberately absent** from this dispatch table —
operator tokens are validated exclusively via the separate `verifyAdminToken()`
path (`src/lib/auth/tokens/admin-token.ts:41-67`, which itself calls
`validateOperatorToken()`), confirming the operator surface is intentionally
kept out of the general-purpose Bearer dispatcher used by ordinary API routes.

MCP route handlers additionally call `validateMcpToken()`
(`src/lib/mcp/oauth-server.ts:682-760`) directly where a Streamable-HTTP /
SSE handler needs the token without going through the full `authOrToken()`
fallback chain.

---

## Token type matrix

All SHA-256 hash-at-rest columns use the shared `hashToken()` helper
(`src/lib/crypto/crypto-server.ts:169-171`) — unsalted SHA-256 hex, justified
by 256-bit token entropy (same rationale GitHub/Stripe use for their PAT
formats; documented in `docs/architecture/machine-identity.md` § Token
Hashing).

| Token type | Prefix | Issuer route (file:line) | Validator (file:line) | TTL source | Rotation | Revocation | Hash at rest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Session** | none (opaque `sessionToken` cookie value) | `createSession` in the custom adapter — `src/lib/auth/session/auth-adapter.ts:262-398` | `getSessionAndUser()` — `src/lib/auth/session/auth-adapter.ts:111-149`; renewal in `updateSession()` (lines 558-654) | `Session.expires` (idle), computed by `resolveEffectiveSessionTimeouts()` (`src/lib/auth/session/session-timeout.ts:55-155`) from `Tenant.sessionIdleTimeoutMinutes` / `sessionAbsoluteTimeoutMinutes` (+ team overrides); absolute cap anchored to `Session.createdAt` | None (rolling idle-expiry extension only; no token-value rotation) | `deleteSession()` (`auth-adapter.ts:445-452`); user-facing "sign out everywhere" via `src/app/api/sessions/route.ts` / `src/app/api/sessions/[id]/route.ts` | **Not hashed** — `Session.sessionToken` stored as plaintext (Auth.js core convention for its own session-token column) |
| **ApiKey** | `api_` | `POST /api/api-keys` — `handlePOST()`, `src/app/api/api-keys/route.ts:69` | `validateApiKey()` — `src/lib/auth/tokens/api-key.ts:67-140` | `ApiKey.expiresAt`; defaults `DEFAULT_API_KEY_EXPIRY_DAYS=90`, cap `MAX_API_KEY_EXPIRY_DAYS` (`src/lib/constants/auth/api-key.ts`) | None | `DELETE /api/api-keys/[id]` — `handleDELETE()`, `src/app/api/api-keys/[id]/route.ts:13` (sets `revokedAt`) | `ApiKey.tokenHash` (SHA-256 hex, `hashToken()`); `prefix` column stores display-only first chars |
| **ExtensionToken** | none (opaque) | `issueExtensionToken()` — `src/lib/auth/tokens/extension-token.ts:194-269`, called from `POST /api/extension/token/exchange`; iOS variant `issueIosToken()` — `src/lib/auth/tokens/mobile-token.ts:107-212` | `validateExtensionToken()` — `src/lib/auth/tokens/extension-token.ts:62-175`, dispatching to DPoP validators (`src/lib/auth/dpop/validate-token-dpop.ts` for browser; `validateIosTokenDpop()`, `mobile-token.ts:336-397`, for iOS) | `ExtensionToken.expiresAt`; browser idle TTL from `Tenant.extensionTokenIdleTimeoutMinutes`; iOS uses hardcoded `IOS_TOKEN_IDLE_TIMEOUT_MS` (1 day) / `IOS_TOKEN_ABSOLUTE_TIMEOUT_MS` (7 days) (`mobile-token.ts:44-45`), not tenant-configurable | Family-based (`familyId`/`familyCreatedAt`); `refreshIosToken()` (`mobile-token.ts:477-584`) atomically rotates old→new with replay detection | `revokeExtensionTokenFamily()` / `revokeAllExtensionTokensForUser()` (`extension-token.ts:287-358`) | `ExtensionToken.tokenHash` (SHA-256 hex); `cnfJkt` (DPoP key thumbprint) also stored, not a secret |
| **ServiceAccountToken** | `sa_` | `POST /api/tenant/service-accounts/[id]/tokens` — `handlePOST()`, `src/app/api/tenant/service-accounts/[id]/tokens/route.ts:81` | `validateServiceAccountToken()` — `src/lib/auth/tokens/service-account-token.ts:69-144` | `ServiceAccountToken.expiresAt`; `DEFAULT_SA_TOKEN_EXPIRY_DAYS=90`, cap `MAX_SA_TOKEN_EXPIRY_DAYS` (`src/lib/constants/auth/service-account.ts`) | None | `DELETE /api/tenant/service-accounts/[id]/tokens/[tokenId]` — `handleDELETE()`, `.../[tokenId]/route.ts:19` (sets `revokedAt`) | `ServiceAccountToken.tokenHash` (SHA-256 hex); `prefix` column display-only |
| **OperatorToken** | `op_` | `POST /api/tenant/operator-tokens` — `handlePOST()`, `src/app/api/tenant/operator-tokens/route.ts:118` | `validateOperatorToken()` — `src/lib/auth/tokens/operator-token.ts:69-141`; admin-facing wrapper `verifyAdminToken()` — `src/lib/auth/tokens/admin-token.ts:41-67` | `OperatorToken.expiresAt`; `OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS=30`, min 1 / max 90 days (`src/lib/constants/auth/operator-token.ts`) | None | `DELETE /api/tenant/operator-tokens/[id]` — `handleDELETE()`, `.../[id]/route.ts:28` (sets `revokedAt`) | `OperatorToken.tokenHash` (SHA-256 hex); `prefix` column stores first 8 chars for UI |
| **McpAccessToken** | `mcp_` | `exchangeCodeForToken()` — `src/lib/mcp/oauth-server.ts:163-296` (mint at line 238), called from `POST /api/mcp/token` | `validateMcpToken()` — `src/lib/mcp/oauth-server.ts:682-760` | `McpAccessToken.expiresAt`; `MCP_TOKEN_EXPIRY_SEC` (1h), capped by `MCP_TOKEN_MAX_EXPIRY_SEC` (1d) (`src/lib/constants/auth/mcp.ts:45-46`) | Re-minted (not self-rotated) on each refresh-token exchange — `exchangeRefreshToken()`, `oauth-server.ts:360-612` | `revokeToken()` (RFC 7009) — `oauth-server.ts:772-829`; bulk via `revokeFamilyOutOfBand()` (lines 620-656) | `McpAccessToken.tokenHash` (SHA-256 hex) |
| **McpRefreshToken** | `mcpr_` | `createRefreshToken()` — `src/lib/mcp/oauth-server.ts:305-338`; re-minted inline during rotation (`exchangeRefreshToken()`, lines 488-490) | `exchangeRefreshToken()` — `src/lib/mcp/oauth-server.ts:360-612` (validation is inline in the atomic rotation transaction; no standalone validate function) | `McpRefreshToken.expiresAt`; `MCP_REFRESH_TOKEN_EXPIRY_SEC` (7d), family absolute cap `MCP_REFRESH_TOKEN_FAMILY_ABSOLUTE_TIMEOUT_SEC` (30d) enforced against `familyCreatedAt` (`src/lib/constants/auth/mcp.ts:76,80`) | `familyId`/`familyCreatedAt`-grouped rotation chain; CAS on `rotatedAt IS NULL` (`updateMany`, `oauth-server.ts:495-498`); replay or lost-race triggers fail-closed family-wide revocation (RFC 9700 §4.14.2 semantics) | `revokeFamilyOutOfBand()` (line 620); `revokeToken()` revokes the entire family when the target is a refresh token (lines 789-809) | `McpRefreshToken.tokenHash` (SHA-256 hex); `replacedByHash` tracks the superseding token's hash for forensics |
| **DelegationSession** | none (UUID session ID, not a bearer secret — access is gated by the caller's already-authenticated MCP token) | `POST /api/vault/delegation` — `handlePOST()`, `src/app/api/vault/delegation/route.ts:80-271` (row create at 189-200) | `findActiveDelegationSession()` — `src/lib/auth/access/delegation.ts:245-261` (checks `revokedAt: null`, `expiresAt > now`) | `DelegationSession.expiresAt` = `min(ttlSeconds ?? tenant.delegationDefaultTtlSec, tenant.delegationMaxTtlSec)` (route.ts:137-149); code defaults `DELEGATION_DEFAULT_TTL_SEC` (15m) / `DELEGATION_MAX_TTL_SEC` (1h) / `DELEGATION_MIN_TTL_SEC` (5m) (`delegation.ts:26-29`) | None — creating a new delegation session for the same `mcpTokenId` revokes the prior one (one-active-per-token, route.ts:171-185, 242-264) | `revokeDelegationSession()` (single, `delegation.ts:311-342`); `revokeAllDelegationSessions()` (bulk, e.g. vault lock, `delegation.ts:263-309`), exposed via `DELETE /api/vault/delegation` | DB row carries no secret; the delegated entry **metadata** (title/username/urlHost/tags) is stored separately in Redis, AES-256-GCM envelope-encrypted per entry (`encryptDelegationEntry()`, `delegation.ts:55-64`), TTL-mirrored via Redis `PX` |
| **Magic-link verification token** | none | Auth.js `EmailProvider` (`src/auth.config.ts`, `sendVerificationRequest` ~line 113); `maxAge: MAGIC_LINK_TTL_SEC` set at line 112 | Handled internally by Auth.js core / `@auth/prisma-adapter`'s default `useVerificationToken` — the custom adapter (`src/lib/auth/session/auth-adapter.ts`) does not override `createVerificationToken`/`useVerificationToken`, so this falls through to library-default behavior | `MAGIC_LINK_TTL_SEC = MAGIC_LINK_TTL_MINUTES * SEC_PER_MINUTE`, `MAGIC_LINK_TTL_MINUTES=15` (`src/lib/constants/auth/magic-link.ts:6-7`) | N/A — single-use, consumed on redemption (Auth.js core behavior) | N/A beyond expiry/single-use consume | **Unverified in this pass**: whether `VerificationToken.token` is stored raw or hashed depends on `@auth/prisma-adapter`'s library-default behavior, which this repo does not override; do not assert either way without checking the installed adapter version's source. |
| **Mobile/extension bridge codes** | none (opaque code, delivered out-of-band e.g. deep link) | Browser: `POST /api/extension/bridge-code` — `handlePOST()`, `src/app/api/extension/bridge-code/route.ts:91-327` (create at 285-296). iOS: `GET /api/mobile/authorize` — `handleGET()`, `src/app/api/mobile/authorize/route.ts:114-244` (create at 200-217) | Consumption is inline in the exchange handlers, not a separate named function: browser `POST /api/extension/token/exchange` — `handlePOST()`, `src/app/api/extension/token/exchange/route.ts:80` (codeHash lookup at line 116); iOS `POST /api/mobile/token` — `handlePOST()`, `src/app/api/mobile/token/route.ts:90` (codeHash lookup at line 124) | `ExtensionBridgeCode.expiresAt` / `MobileBridgeCode.expiresAt`, both driven by the shared `BRIDGE_CODE_TTL_MS` constant | None — single-use (`usedAt` column set on redemption); `BRIDGE_CODE_MAX_ACTIVE` evicts oldest unused codes on new issuance (`bridge-code/route.ts:272-284`) | Implicit via `usedAt` set on consume or eviction; no explicit revoke endpoint | `ExtensionBridgeCode.codeHash` / `MobileBridgeCode.codeHash` (SHA-256 hex, `hashToken()`); also store `cnfJkt` / `deviceJkt` + `codeChallenge` (PKCE) — not secrets in the credential sense |
| **JIT access tokens** | `sa_` (same DB model as ServiceAccountToken — distinguished only by `name: "JIT-${requestId.slice(0,8)}"`, not a separate token type) | `POST /api/tenant/access-requests/[id]/approve` — `handlePOST()`, `src/app/api/tenant/access-requests/[id]/approve/route.ts:36-243` (mint at lines 186-200) | Same as ServiceAccountToken — `validateServiceAccountToken()` (`service-account-token.ts:69-144`); no dedicated JIT validator | `Tenant.jitTokenDefaultTtlSec` / `jitTokenMaxTtlSec` (fallback `SEC_PER_HOUR` / `JIT_TOKEN_TTL_MAX`), computed at approve/route.ts:124-133 | None | Shared `ServiceAccountToken.revokedAt` path; no JIT-specific revoke route (standard SA-token-delete route applies) | `ServiceAccountToken.tokenHash` (SHA-256 hex — same column/mechanism as ordinary SA tokens) |

**JIT-specific safeguards worth noting** (approve/route.ts): self-approval is
explicitly blocked (`API_ERROR.FORBIDDEN_SELF_APPROVAL`, lines 89-109); an
atomic `transition()` state-machine guard prevents re-issuing a token for an
already-approved/expired request (lines 166-176); a per-SA
`pg_advisory_xact_lock` plus `MAX_SA_TOKENS_PER_ACCOUNT` cap (lines 142-156)
prevent a token-limit bypass race.

**SCIM bearer token** (not one of the 10 enumerated token classes above, but
part of the auth surface grid): `validateScimToken()` —
`src/lib/auth/tokens/scim-token.ts:57-123`; prefix `SCIM_TOKEN_PREFIX = "scim_"`
(`src/lib/scim/token-utils.ts:4`); hash at rest `ScimToken.tokenHash`
(SHA-256 hex, `hashToken()`).
