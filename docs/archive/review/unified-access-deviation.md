# Coding Deviation Log: unified-access
Created: 2026-03-28T07:40:00+09:00

## Deviations from Plan

### DEV-01: McpClient field renamed from `clientSecret` to `clientSecretHash`
- **Plan description**: Schema defines `clientSecret String @map("client_secret")` to store SHA-256 hash of the client secret.
- **Actual implementation**: Field renamed to `clientSecretHash String @map("client_secret_hash")` in both Prisma schema and migration SQL.
- **Reason**: The rename makes the storage semantic explicit at the schema level, reducing risk of treating the column as a plaintext secret. Improves clarity without behavior change.
- **Impact scope**: `prisma/schema.prisma`, `prisma/migrations/20260327224315_add_mcp_gateway/migration.sql`, `src/app/api/tenant/mcp-clients/`, `src/lib/mcp/oauth-server.ts`.

### DEV-02: `proxy.ts` Bearer bypass list not updated for SA token routes
- **Plan description**: Phase 1 step 9 explicitly required updating `src/proxy.ts` to add SA-targeted routes (`/api/passwords`, `/api/v1/*`, `/api/tags`, `/api/vault/status`) to the Bearer bypass list and registering `/api/tenant/service-accounts` as a session-required route.
- **Actual implementation**: `src/proxy.ts` was not modified. The existing `extensionTokenRoutes` array in the production proxy already includes `/api/passwords` and `/api/vault/status`, and `/api/v1/*` is already handled separately as a public REST API route. The plan's concern was apparently already addressed by the existing route structure. No new entries were added for SA specifically.
- **Reason**: The plan described adding SA routes to the bypass list, but the existing proxy already passes Bearer auth through for the relevant routes. No regression observed in behavior. However, the plan's explicit instruction (step 9) was not followed — the proxy was not touched at all despite a diff showing `src/proxy.ts` had no changes.
- **Impact scope**: `src/proxy.ts`. Potential gap: if new SA-only routes are added later, they may be silently blocked by the session check before the route handler can validate the SA token.

### DEV-03: MCP `resolveActorType()` does not handle `mcp_agent` auth type
- **Plan description**: Phase 4 describes `resolveActorType()` inferring `ActorType` from `AuthResult`. `ActorType` includes `MCP_AGENT` as a distinct value. MCP tokens are issued via OAuth 2.1 and are separate from SA tokens.
- **Actual implementation**: `resolveActorType()` in `src/lib/audit.ts` only handles `session`, `token`, `api_key`, and `service_account` cases. There is no `mcp_agent` case. MCP access tokens (`mcp_` prefix) are not integrated into the `authOrToken()` pipeline at all — MCP routes authenticate via a dedicated `validateMcpToken()` call inside `src/app/api/mcp/route.ts`, bypassing `authOrToken`. As a result, MCP tool calls are never audited with `actorType = MCP_AGENT`.
- **Reason**: Phase 3 implemented MCP as a separate auth path rather than integrating into `authOrToken()`. Audit integration for MCP agent actions was deferred.
- **Impact scope**: `src/lib/audit.ts`, `src/lib/auth-or-token.ts`, `src/app/api/mcp/route.ts`. The `MCP_AGENT` ActorType enum value exists in the schema but is never written to `audit_logs` by any code path.

### DEV-04: JIT approval endpoint uses `withBypassRls` inside business logic
- **Plan description**: The plan explicitly states: "`withBypassRls()` は JIT ビジネスロジック内では使用しない (データ操作層の制限)." The exception granted was only for `logAudit` internal infrastructure use.
- **Actual implementation**: `src/app/api/tenant/access-requests/[id]/approve/route.ts` uses `withBypassRls` to read the tenant policy columns (`jitTokenDefaultTtlSec`, `jitTokenMaxTtlSec`) from the `tenants` table. The business-logic transaction itself uses `prisma.$transaction` without explicit RLS bypass.
- **Reason**: Tenant policy columns were added to the `tenants` table. Reading the calling user's own tenant record via RLS-scoped queries would work given the session context, but `withBypassRls` was used for simplicity. The actual approval and token creation are inside a `prisma.$transaction` (without explicit bypass), which may inherit or not inherit RLS depending on session context.
- **Impact scope**: `src/app/api/tenant/access-requests/[id]/approve/route.ts`. The bypass is narrow (read-only, own tenant) and low risk, but deviates from the stated constraint.

### DEV-05: JIT access request creation requires session auth (admin-only), not SA-initiated
- **Plan description**: Phase 2 step 1 describes "SA が `POST /api/tenant/access-requests` でスコープ要求" — i.e., service accounts themselves initiate JIT requests using their SA token Bearer auth.
- **Actual implementation**: `POST /api/tenant/access-requests` checks `auth()` (session) and calls `requireTenantPermission(..., SERVICE_ACCOUNT_MANAGE)`. This is admin-only, not SA-initiated. A service account holding an `sa_` Bearer token cannot create an access request for itself.
- **Reason**: The implementation treats the JIT workflow as an admin-driven operation (admin creates request on behalf of SA) rather than SA self-service. This simplifies auth but diverges from the plan's intent.
- **Impact scope**: `src/app/api/tenant/access-requests/route.ts`. The SA self-service aspect of JIT is not realized.

### DEV-06: Notification integration for JIT workflow not implemented
- **Plan description**: Phase 2 step 2 requires "Tenant admin に Notification 通知" when a JIT access request is created (using the existing `Notification` model).
- **Actual implementation**: `POST /api/tenant/access-requests` creates the access request and fires a webhook but does not create a `Notification` record. No `prisma.notification.create` call exists in the access request handlers.
- **Reason**: Not implemented. Explicitly flagged as a gap in Phase 2 step 15 ("Notification 連携"), which was listed but not completed.
- **Impact scope**: `src/app/api/tenant/access-requests/route.ts`. Tenant admins receive no in-app notification for pending JIT requests.

### DEV-07: Unified activity dashboard not implemented
- **Plan description**: Phase 4 step 29 requires `src/app/[locale]/dashboard/admin/activity/page.tsx` — a tenant admin unified activity view with `actorType` filter and cursor-based pagination.
- **Actual implementation**: The file does not exist. The `dashboard/admin/` directory does not exist at all. No new dashboard page was added.
- **Reason**: Not implemented. This was listed as a Phase 4 item but was not created in the branch.
- **Impact scope**: Missing frontend feature. The backend data (actorType column, indexes) is present but no UI exposes it.

### DEV-08: Audit log actorType filter on existing API endpoints not added
- **Plan description**: Phase 4 step 30 requires adding `actorType` filter support to existing audit log API endpoints (`/api/audit-logs`, `/api/tenant/audit-logs`, etc.).
- **Actual implementation**: The audit log endpoint diffs show no changes to existing audit log query handlers. The `actorType` column and index exist in the DB but the existing list/download endpoints do not expose the filter parameter.
- **Reason**: Not implemented. Listed as a Phase 4 step but skipped.
- **Impact scope**: `/api/audit-logs`, `/api/tenant/audit-logs`, `/api/teams/[teamId]/audit-logs`.

### DEV-09: Migration backfill for existing `audit_logs` rows is implicit (DEFAULT only), not explicit batched UPDATE
- **Plan description**: Phase 4 migration plan specifies an explicit two-step backfill: Step 1 adds columns with DEFAULT, Step 2 runs `UPDATE audit_logs SET actor_type = 'HUMAN' WHERE actor_type IS NULL` (batched for large tables), followed by a post-migration assertion `SELECT COUNT(*) FROM audit_logs WHERE actor_type IS NULL` = 0. A separate test file `scripts/__tests__/migration-audit-actor-type.test.mjs` was to be created.
- **Actual implementation**: The migration SQL (`20260327221357_add_actor_type_and_access_requests/migration.sql`) adds the column with `NOT NULL DEFAULT 'HUMAN'` in a single `ALTER TABLE` statement. No explicit `UPDATE` backfill step is present, and no post-migration assertion script was created. PostgreSQL handles the DEFAULT application atomically for `NOT NULL DEFAULT`, so existing rows get the default value without a separate UPDATE — this is functionally equivalent but does not follow the documented procedure.
- **Reason**: PostgreSQL 12+ applies `NOT NULL DEFAULT` column additions without a table rewrite (the default is stored in system catalogs and applied on read). The explicit UPDATE is unnecessary for correctness, but the plan specified it as a safety measure and documentation of intent. The assertion script is a monitoring gap.
- **Impact scope**: `prisma/migrations/20260327221357_add_actor_type_and_access_requests/migration.sql`. No `scripts/__tests__/migration-audit-actor-type.test.mjs` file created.

### DEV-10: MCP SSE transport implemented as minimal stub
- **Plan description**: Phase 3 specifies MCP Streamable HTTP at `/api/mcp` with full SSE support for server-initiated messages.
- **Actual implementation**: The `GET /api/mcp` endpoint sends a single `event: endpoint\ndata: /api/mcp\n\n` line and immediately closes the stream. This is a stub that satisfies the MCP protocol's endpoint discovery but does not implement persistent SSE for server-initiated messages.
- **Reason**: The implementation comment reads "Basic SSE stream — sends a single endpoint event then closes." Full bidirectional streaming was deferred.
- **Impact scope**: `src/app/api/mcp/route.ts`. MCP clients that rely on server-initiated notifications (e.g., resource change events) will not receive them.

### DEV-11: `auth-or-token.ts` prefix dispatch table logic has a subtle ordering issue
- **Plan description**: The plan describes a prefix table approach where unknown prefixes are explicitly rejected (return null) before the extension token path, preventing fallthrough. The pseudocode shows a clean `if/else if/else` with explicit `scim_` handling and unknown prefix → null.
- **Actual implementation**: The implementation dispatches in this order: (1) `api_` → API key, (2) `sa_` → SA token, (3) check if bearer starts with any `KNOWN_PREFIXES` → return null, (4) extension token path. However, `KNOWN_PREFIXES` includes `"scim_"` and `API_KEY_PREFIX` and `SA_TOKEN_PREFIX` — meaning by the time step (3) is reached, `api_` and `sa_` tokens have already been handled. The KNOWN_PREFIXES guard at step (3) effectively only catches `scim_` tokens (since `api_` and `sa_` are already returned above). The logic is correct but slightly redundant in the guard condition.
- **Reason**: Minor implementation detail — functionally equivalent to the plan but the `KNOWN_PREFIXES` set includes already-handled prefixes, making the guard condition read as if it handles more cases than it does at that point.
- **Impact scope**: `src/lib/auth-or-token.ts`. No security impact.

### DEV-12: `saTokenMaxExpiryDays` tenant policy enforced via constant, not DB column at token creation
- **Plan description**: Phase 2 adds `saTokenMaxExpiryDays` to tenant policy. Phase 1's `saTokenCreateSchema` should enforce this per-tenant limit at token creation time.
- **Actual implementation**: `src/lib/validations/service-account.ts` uses `MAX_SA_TOKEN_EXPIRY_DAYS` constant (365 days) from `src/lib/constants/service-account.ts` for the expiry validation. The token creation route handler does not fetch the tenant's `saTokenMaxExpiryDays` column. The per-tenant override is stored in the DB schema but not consulted during token creation.
- **Reason**: The constant-based validation was implemented in Phase 1 before Phase 2's per-tenant policy columns existed. Phase 2 added the DB column but did not update the token creation route to use it.
- **Impact scope**: `src/app/api/tenant/service-accounts/[id]/tokens/route.ts`, `src/lib/validations/service-account.ts`. All tenants are effectively capped at 365 days regardless of their policy setting.

### DEV-13: `MCP_AGENT` actorType value not used by `resolveActorType` despite enum existing in schema
- **Plan description**: The `ActorType` enum includes `MCP_AGENT` and Phase 4 step 27 adds it. `resolveActorType()` should derive actor type from `AuthResult`.
- **Actual implementation**: Covered by DEV-03 above — the `SYSTEM` actorType is also never written (no code path produces it either). Both `MCP_AGENT` and `SYSTEM` exist in the enum but are dead values in practice.
- **Reason**: See DEV-03. Listed separately for completeness.
- **Impact scope**: `src/lib/audit.ts`. The `SYSTEM` case is also unused — no system-initiated audit events are generated.

### DEV-14: `src/app/api/tenant/access-requests/[id]/route.ts` — GET single request lacks tenant isolation check
- **Plan description**: Plan specifies cross-tenant IDOR prevention: `accessRequest.tenantId === approver.tenantId`. The approve endpoint implements this via `WHERE id = ? AND tenantId = ?` in `updateMany`. The GET single endpoint is expected to follow the same pattern.
- **Actual implementation**: The GET single endpoint (`src/app/api/tenant/access-requests/[id]/route.ts`) uses `withTenantRls` which provides RLS-based isolation, which is the correct pattern. No deviation here — RLS handles tenant isolation for reads consistently with the rest of the codebase.
- **Reason**: Not a deviation — RLS-based isolation is sufficient and consistent with existing patterns.
- **Impact scope**: None — listed for completeness as a potential concern that was correctly addressed.

### DEV-15: Phase 3 test coverage for stream error handling and MCP transport not implemented
- **Plan description**: Phase 3 testing requires: MCP stream error handling with `vi.useFakeTimers()` for timeout control and `ReadableStream` mock for mid-stream disconnection simulation; full MCP client → OAuth authorize → token → tool call integration test.
- **Actual implementation**: `src/lib/mcp/oauth-server.test.ts` covers PKCE paths, token exchange success/failure paths (381 lines). No stream error handling tests exist. No full MCP round-trip integration test from client registration through tool call exists.
- **Reason**: Stream error handling tests are complex to set up with Vitest mocks. The OAuth unit tests were implemented but the integration-level transport tests were deferred.
- **Impact scope**: Test coverage gap for MCP transport layer resilience.
