# A07-4 — MCP DCR public/confidential split (v2 + user direction)

> **Plan v2** — round-1 review (3 expert sub-agents) found Critical scope gaps
> (F1/S1/T1 token cascade missing from migration; F2 audit emission uses
> non-existent symbol and silently drops null-tenant rows; F3/S3 audit script
> racy; T4 no real-DB migration test). v2 folds the audit emission into the
> migration SQL (atomic, no race window) and adds the token cascade, an
> integration test, and three static guards. See
> `a07-4-mcp-dcr-public-confidential-review.md` for the round-1 log.
>
> **Round-2 user direction (2026-05-23)**: 「現在、このリポジトリは開発中なので移行は
> 考えなくて良いですよ」— pre-1.0 / no backward-compat. The data migration, audit
> action emission, and related infrastructure are **dropped**. Remaining scope:
> API-layer hardening (Zod literal `"none"`, `isActive` filter on /authorize),
> admin console doc lock-in, tests, and two static guards. See review log
> §Round-2 user direction for the full delta table.

## Project context

- **Type**: web app (Next.js 16 / Auth.js v5 / Prisma 7)
- **Surface**: MCP gateway at `/api/mcp/*` (OAuth 2.1 + DCR per RFC 7591)
- **Affected endpoints**:
  - `/api/mcp/register` — DCR (Dynamic Client Registration), unauthenticated, IP-rate-limited
  - `/api/mcp/authorize`, `/api/mcp/authorize/consent`, `/api/mcp/token` — token issuance
  - `/api/tenant/mcp-clients` — admin console (session + `SERVICE_ACCOUNT_MANAGE` = OWNER/ADMIN)
- **Affected models**: `McpClient` (`isDcr`, `clientSecretHash`, `isActive`), `McpAccessToken`, `McpRefreshToken`
- **Pre-1.0**: existing confidential DCR clients in dev DBs WILL be revoked, with their tokens revoked.

## Objective

Tighten the public/confidential client split for MCP OAuth per RFC 9700 §4.14:

1. **DCR endpoint** (`/api/mcp/register`) MUST issue public clients only.
   `token_endpoint_auth_method` MUST be the literal `"none"`; any other value
   (including absent, wrong case, array/null/numeric) is `invalid_client_metadata`.
2. **Existing confidential DCR clients and their tokens are revoked** in one
   atomic Prisma migration. The migration also enqueues per-client
   `MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL` audit_outbox rows (no separate script
   needed).
3. **Confidential clients remain available** via the admin console
   (`POST /api/tenant/mcp-clients`), which already requires session auth +
   `SERVICE_ACCOUNT_MANAGE` (OWNER/ADMIN only) + step-up reauth. This plan adds
   a code comment locking that gate in; no behavioral change.
4. **Defense-in-depth**: `validateOAuthRequest` in `/api/mcp/authorize` adds an
   `isActive: true` filter so revoked clients fail fast (no login-then-error
   UX leak). Token endpoint already enforces (verified — see §6).

## Scope decision

| Concern | In scope | Notes |
|---|---|---|
| Reject confidential DCR registration | ✅ | Literal `"none"` required via `z.literal` |
| Wrong-shape (null, array, case-mismatch) inputs | ✅ | Covered by `z.literal`; tested |
| Revoke existing confidential DCR clients | ✅ | `is_active = false` via migration |
| Revoke their access tokens | ✅ | `revoked_at = NOW()` via same migration CTE |
| Revoke their refresh tokens | ✅ | Same migration CTE |
| Audit emission for revocation | ✅ | INSERT INTO audit_outbox inside the migration |
| New `MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL` action | ✅ | Adds to `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_TENANT[MCP_CLIENT]`, i18n |
| `isActive` enforcement on `/api/mcp/authorize` | ✅ | Defense-in-depth |
| `isActive` enforcement on `/api/mcp/token` | ✅ verified — no change needed | `oauth-server.ts:170, 376` already gates |
| Admin console doc lock-in | ✅ | Code comment, no behavioral change |
| Discovery metadata change | ❌ — decision: keep as-is | Token endpoint still accepts both methods (admin-console clients). Locked via contract test |
| Step-up reauth on admin PUT/DELETE | ❌ | Separate auth-method concern, not in original A07-4 prompt. Documented as follow-up |
| Migrate existing confidential DCR clients to public form | ❌ | They are revoked; users re-register |
| i18n missing-key check infrastructure | ❌ | Generic infra; only correct the path in this PR |

## Requirements

### Functional

- **F1** `POST /api/mcp/register` accepts requests with `token_endpoint_auth_method === "none"` (string).
  - Field MUST be present and MUST equal `"none"` exactly (case-sensitive, no whitespace tolerance).
  - Any other value → `400 { error: "invalid_client_metadata", error_description: "token_endpoint_auth_method must be 'none' (DCR issues public clients only — RFC 9700 §4.14)" }`.
  - Response omits `client_secret` and `client_secret_expires_at`.
  - `responseBody.token_endpoint_auth_method = "none"` (literal in code, not variable).
- **F2** A single Prisma migration atomically:
  - Sets `is_active = false`, `updated_at = NOW()` on each confidential DCR client (`is_dcr = true AND COALESCE(client_secret_hash, '') <> '' AND is_active = true`).
  - Sets `revoked_at = NOW()` on every non-revoked `mcp_access_tokens` row whose `client_id` is in the revoked set.
  - Sets `revoked_at = NOW()` on every non-revoked `mcp_refresh_tokens` row whose `client_id` is in the revoked set.
  - Enqueues one `MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL` audit_outbox row per revoked client (tenant_id resolved via `COALESCE(mcp_clients.tenant_id, SYSTEM_TENANT_ID)`).
  - Is **idempotent**: re-running selects zero rows (UPDATE filters on the still-true state).
- **F3** `/api/mcp/authorize` adds `isActive: true` to `validateOAuthRequest` Prisma WHERE clause. Same `invalid_request` response for nonexistent / inactive / bad-redirect cases (anti-enumeration preserved).
- **F4** `/api/mcp/token` (verified): `exchangeCodeForToken` (`oauth-server.ts:170`) and `exchangeRefreshToken` (`oauth-server.ts:376`) already require `isActive = true`. No change. Documented in code comment.
- **F5** Admin console POST handler (`/api/tenant/mcp-clients`) gets a comment block documenting the A07-4 gating contract (session + SERVICE_ACCOUNT_MANAGE + step-up). No behavioral change.

### Non-functional

- No new `any` escape hatches.
- ESLint clean; `npx tsc --noEmit`: pre-existing errors only.
- `npx vitest run`: 100% pass.
- `bash scripts/pre-pr.sh`: 22/22 PASS plus 3 new A07-4 static guards.

## Technical approach

### 1. DCR endpoint — strict literal (Zod 4 syntax)

`src/app/api/mcp/register/route.ts`:

```ts
// Replace line 54 (`token_endpoint_auth_method: z.string().optional()`) with:
const dcrSchema = z.object({
  client_name: z.string().min(1).max(100),
  redirect_uris: z.array(z.string().url()).min(1).max(10).refine(/* ...unchanged... */),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  // A07-4: RFC 9700 §4.14 — DCR clients are public-only (untrusted registrants).
  // Confidential clients must be created via /api/tenant/mcp-clients (admin only).
  token_endpoint_auth_method: z.literal("none", {
    error: () =>
      "token_endpoint_auth_method must be 'none' (DCR issues public clients only — RFC 9700 §4.14)",
  }),
  scope: z.string().optional(),
});
```

Replace lines 114-122 + 188-194 (credential generation + response builder):

```ts
const validatedUris = body.redirect_uris;

// A07-4: DCR issues public clients only — no secret generation.
const clientId = MCP_CLIENT_ID_PREFIX + randomBytes(16).toString("hex");
const clientSecretHash = ""; // schema invariant: NOT NULL; "" sentinel == public/DCR client
const dcrExpiresAt = new Date(Date.now() + MCP_DCR_UNCLAIMED_EXPIRY_SEC * 1000);

// ...transaction unchanged except no isPublicClient ternary needed...

const responseBody: Record<string, unknown> = {
  client_id: client.clientId,
  client_name: body.client_name,
  redirect_uris: validatedUris,
  grant_types: body.grant_types ?? ["authorization_code"],
  response_types: ["code"],
  token_endpoint_auth_method: "none", // A07-4: literal
  client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
};
// No `if (clientSecret)` block — public-only.
return NextResponse.json(responseBody, { status: 201 });
```

Also update the error envelope on Zod failure (line 84-87) to lift the first issue message into `error_description` so the RFC 9700 reference surfaces:

```ts
if (!parsed.success) {
  const issue = parsed.error.issues[0];
  return NextResponse.json(
    {
      error: "invalid_client_metadata",
      error_description: issue?.message ?? "Invalid client metadata",
      issues: parsed.error.issues,
    },
    { status: 400 },
  );
}
```

### 2. Prisma migration — atomic revoke + audit emit

`prisma/migrations/20260524000000_a07_4_revoke_confidential_dcr_clients/migration.sql`:

```sql
-- A07-4: RFC 9700 §4.14 — DCR clients are public-only (untrusted registrants).
-- This migration:
--   (1) Soft-revokes confidential DCR clients (is_dcr=true with non-empty client_secret_hash).
--   (2) Revokes every non-revoked access token + refresh token bound to those clients.
--   (3) Enqueues one MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL audit_outbox row per revoked client.
-- All four steps happen in a single SQL statement chain (Prisma wraps the file in
-- a transaction); no separate post-deploy script is needed.
--
-- Idempotency: each UPDATE filters on the still-actionable state, so a second
-- run finds zero rows and emits no audit rows.
--
-- COALESCE(client_secret_hash, '') defends against a future schema change that
-- makes the column nullable (see static guard `client-secret-hash-non-null` in
-- scripts/pre-pr.sh).

WITH revoked_clients AS (
  UPDATE mcp_clients
  SET is_active  = false,
      updated_at = NOW()
  WHERE is_dcr = true
    AND COALESCE(client_secret_hash, '') <> ''
    AND is_active = true
  RETURNING id, tenant_id, client_id, name
),
revoked_access AS (
  UPDATE mcp_access_tokens
  SET revoked_at = NOW()
  WHERE revoked_at IS NULL
    AND client_id IN (SELECT id FROM revoked_clients)
  RETURNING id
),
revoked_refresh AS (
  UPDATE mcp_refresh_tokens
  SET revoked_at = NOW()
  WHERE revoked_at IS NULL
    AND client_id IN (SELECT id FROM revoked_clients)
  RETURNING id
)
INSERT INTO audit_outbox (tenant_id, payload)
SELECT
  COALESCE(tenant_id, '00000000-0000-4000-8000-000000000002'::uuid) AS tenant_id,
  jsonb_build_object(
    'scope',            'TENANT',
    'action',           'MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL',
    'userId',           '00000000-0000-4000-8000-000000000001',
    'actorType',        'SYSTEM',
    'serviceAccountId', NULL,
    'teamId',           NULL,
    'targetType',       'McpClient',
    'targetId',         id::text,
    'metadata', jsonb_build_object(
      'clientId',  client_id,
      'name',      name,
      'reason',    'a07-4-dcr-public-only',
      'rfc',       'RFC 9700 §4.14'
    ),
    'ip',         NULL,
    'userAgent',  'a07-4-migration'
  )
FROM revoked_clients;
```

**Interaction with `dcr-cleanup-worker`**: the worker filters on
`is_dcr=true AND tenant_id IS NULL AND dcr_expires_at < now()` and does NOT check
`is_active`. Revoked unclaimed clients (`tenant_id IS NULL`) will still be hard-
deleted by the worker after their 24h DCR expiry — desired behaviour (no orphan
revoked rows). Revoked claimed clients (`tenant_id IS NOT NULL`) remain in the
table indefinitely (audit trail preserved).

### 3. New audit action

`src/lib/constants/audit/audit.ts`:

```ts
// AUDIT_ACTION (line ~144 area, after MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL):
MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL: "MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL",

// AUDIT_ACTION_VALUES (line ~320 area):
AUDIT_ACTION.MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL,

// AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.MCP_CLIENT] (line ~660 area):
AUDIT_ACTION.MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL,
```

`messages/en/AuditLog.json` and `messages/ja/AuditLog.json`:

```json
"MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL": "MCP DCR confidential client revoked (public-only enforcement)"
```

(Japanese: `"MCP DCR の confidential クライアントを失効 (public-only 強制)"`)

Tenant webhooks inherit transitively via `TENANT_WEBHOOK_EVENT_GROUPS` — admins
get notified of automated revocations.

### 4. Defense-in-depth: isActive on /authorize

`src/app/api/mcp/authorize/route.ts:25`:

```ts
tx.mcpClient.findFirst({
  where: { clientId, isActive: true }, // A07-4: revoked clients fail upfront (defense-in-depth)
  select: { redirectUris: true },
}),
```

Anti-enumeration is preserved: the calling site already returns the same
`invalid_request` envelope for null-return, redirect-mismatch, and any other
failure. Verified the 3 McpClient lookup sites:

| Site | File:line | isActive gated? |
|---|---|---|
| `validateOAuthRequest` (authorize GET pre-auth) | `authorize/route.ts:25` | ❌ → adding in F3 |
| `consent` (POST after session) | `authorize/consent/route.ts:48` | ✅ already |
| `validateMcpToken` (token-exchange code-path) | `oauth-server.ts:170, 376` | ✅ already |

### 5. Admin console — doc lock-in

`src/app/api/tenant/mcp-clients/route.ts handlePOST` — add comment after the
function signature (no behavioral change):

```ts
async function handlePOST(req: NextRequest) {
  // A07-4: Confidential MCP clients are admin-only.
  //   Authentication:  session cookie required (auth() below).
  //   Authorization:   SERVICE_ACCOUNT_MANAGE permission → OWNER/ADMIN only,
  //                    resolved by requireTenantPermission via ROLE_PERMISSIONS in
  //                    src/lib/auth/access/tenant-auth.ts.
  //   Step-up:         requireRecentCurrentAuthMethod enforces recent auth ceremony.
  //
  // DCR (/api/mcp/register) is the public-only alternative for self-service
  // registration. See RFC 9700 §4.14.
  //
  // Out of scope for A07-4 (track as follow-up): PUT/DELETE handlers in
  // [id]/route.ts do not require step-up reauth — consider adding for parity.
  // ... existing logic ...
}
```

### 6. Discovery metadata — lock array via contract test

No code change to `oauth-authorization-server/route.ts`. Decision recorded in
plan: `token_endpoint_auth_methods_supported` advertises both
`client_secret_post` and `none` because the *token* endpoint accepts both
(admin-console-created confidential clients still use `client_secret_post`).
DCR's narrower constraint is enforced via the registration response.

Add an assertion in the existing `mcp-oauth-flow.test.ts` Scenario 7:

```ts
expect(json.token_endpoint_auth_methods_supported).toEqual(
  ["client_secret_post", "none"],
);
```

## Tests

### Unit tests — register/route.test.ts

Remove the obsolete default-method test (line 90-110 expecting
`"client_secret_post"`). Add:

- **T-A07-4-1** (positive + DB-write contract): POST with `"none"` → 201, no
  `client_secret`, no `client_secret_expires_at`, `token_endpoint_auth_method ===
  "none"`. **Also** assert `mockPrismaCreate` was called with
  `data: expect.objectContaining({ clientSecretHash: "", isDcr: true })`.
- **T-A07-4-2** through **T-A07-4-2g** (`it.each`): wrong-shape rejection — each
  returns 400 `invalid_client_metadata`, body's `error_description` mentions
  "RFC 9700":
  - `undefined` / absent
  - `null`
  - empty string `""`
  - `"None"` (case mismatch)
  - `" none "` (whitespace)
  - `["none"]` (array)
  - `0` (number)
  - `false` (boolean)
- **T-A07-4-3**: POST with `"client_secret_post"` → 400 (legacy rejection
  regression).
- **T-A07-4-4**: POST with `"client_secret_basic"` → 400.

### Unit tests — authorize/route.test.ts

`VALID_CLIENT` fixture: add `isActive: true` explicitly (T13 fix).

- **T-A07-4-5a** (inactive): mockFindFirst returns null because `isActive: true`
  WHERE doesn't match → 400 `invalid_request`, no login redirect.
- **T-A07-4-5b** (nonexistent): mockFindFirst returns null → identical 400
  envelope. Same body shape as 5a (anti-enumeration).
- **T-A07-4-5c** (active, bad redirect): mockFindFirst returns active client,
  redirect_uri not in list → identical 400 envelope.
- **T-A07-4-5d** (active, good redirect): success path unchanged.

Assert `mockFindFirst.mock.calls[0][0].where` includes `isActive: true` so the
WHERE-shape regression can be caught.

### Unit tests — mcp-oauth-flow.test.ts Scenario 7

Add the `token_endpoint_auth_methods_supported` array assertion (T5 fix).

### Integration test — real DB migration

`src/__tests__/integration/a07-4-dcr-revoke-migration.test.ts`:

```
Setup (seed before migration applied):
  - Tenant T1 (real row)
  - Confidential DCR client C1 (is_dcr=true, tenant_id=NULL, hash="abc...")
  - Public DCR client C2 (is_dcr=true, tenant_id=NULL, hash="")
  - Admin-console client C3 (is_dcr=false, tenant_id=T1, hash="def...")
  - Claimed confidential DCR client C4 (is_dcr=true, tenant_id=T1, hash="ghi...")
  - C1 has an active access token AT1 and refresh token RT1
  - C4 has an active access token AT4 and refresh token RT4
  - C3 has an active access token AT3 (should NOT be touched)

Action:
  - Read prisma/migrations/20260524000000_a07_4_revoke_confidential_dcr_clients/migration.sql
  - Execute as raw SQL against the test DB

Assertions:
  - C1.is_active = false ; C2.is_active = true ; C3.is_active = true ; C4.is_active = false
  - AT1.revoked_at IS NOT NULL ; AT3.revoked_at IS NULL ; AT4.revoked_at IS NOT NULL
  - RT1.revoked_at IS NOT NULL ; RT4.revoked_at IS NOT NULL
  - audit_outbox has 2 rows for action=MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL
    - One with tenant_id=SYSTEM_TENANT_ID (C1 unclaimed)
    - One with tenant_id=T1 (C4 claimed)
  - payload structure validated (scope, action, userId, actorType, metadata.reason="a07-4-dcr-public-only")

Re-run migration:
  - All UPDATE filters select 0 rows
  - audit_outbox count unchanged
  - No errors
```

Uses the existing real-Postgres harness pattern from
`src/__tests__/integration/mcp-oauth-flow.test.ts`. The pre-pr.sh integration
gate fires on `prisma/migrations/**` diffs (verify, expand the gate if needed).

### Static guards (`scripts/pre-pr.sh`)

Add three:

1. **`dcr-public-only-literal`** — `src/app/api/mcp/register/route.ts` must use
   `z.literal("none"` (single quotes also accepted) AND must NOT contain
   `client_secret_post` literal AND must NOT contain `randomBytes(32)`.
2. **`dcr-confidential-revoke-migration-immutable`** — once shipped, the
   migration file `20260524000000_a07_4_revoke_confidential_dcr_clients/migration.sql`
   must not be modified (Prisma migration invariant — same pattern as
   `prf-salt-migration-script-readonly`).
3. **`client-secret-hash-non-null`** — `prisma/schema.prisma` must declare
   `clientSecretHash String @map(...)` without the `?` nullability marker. The
   migration SQL's `COALESCE(...)` defense relies on this invariant; if a future
   schema change makes the column nullable, this guard fails so the team
   re-audits.

## Out of scope

- Migrating existing confidential DCR clients to public form. Revoked-only.
- Renaming `clientSecretHash` to allow `NULL`. Empty-string sentinel kept.
- Step-up reauth on admin `PUT`/`DELETE` (`/api/tenant/mcp-clients/[id]`). Documented as follow-up in §5 comment.
- i18n missing-key check infrastructure. Out of scope; only correct the json path in this PR.
- CLI `passwd-sso login` UX changes. Verified `cli/src/lib/oauth.ts` catches `invalid_client` during refresh and triggers re-registration.

## Considerations / risks

- **R1 (Behavior change, owned)**: Any DCR client that registered with
  `client_secret_post` is revoked by this migration and must re-register with
  `"none"`. Pre-1.0 acceptable. The CLI auto-recovers on `invalid_client`; other
  MCP clients need user action.
- **R2 (Token cascade)**: Closed by §2 migration — access + refresh tokens are
  revoked atomically with the client. Tested by the integration test above.
- **R3 (Race window during deploy)**: If a confidential DCR client is created
  between migration run and code deploy, it survives. Mitigated by the
  migration's strict idempotency (re-runnable any time post-deploy) and by the
  static guard `dcr-public-only-literal` ensuring the code path is closed.
- **R4 (Audit query-ability for unclaimed clients)**: Unclaimed-client audit
  rows use `SYSTEM_TENANT_ID` — they are visible only to operators who can
  query the system tenant's audit log. Acceptable: unclaimed DCR clients have
  no tenant owner to receive the notification anyway.
- **R5 (`clientSecretHash` schema invariant)**: Defended by the static guard
  `client-secret-hash-non-null` and the migration's `COALESCE(...)` clause.

## Acceptance gates

- `bash scripts/pre-pr.sh`: 25/25 PASS (22 existing + 3 new A07-4 guards).
- `npx vitest run`: 100% PASS.
- `npx next build`: success.
- Manual smoke test plan (separate doc) executes cleanly — scope outlined below.

## Manual smoke test scope (post-impl, separate doc)

1. **CLI**: `passwd-sso login` end-to-end via DCR public-only flow. Assert no
   `client_secret` in cached credentials.
2. **Confidential DCR rejection**: `curl -X POST .../api/mcp/register` with
   `token_endpoint_auth_method: "client_secret_post"` → 400 with RFC 9700
   reference in `error_description`.
3. **Wrong-shape rejection**: `curl` with `token_endpoint_auth_method` absent →
   400; with `"None"` → 400.
4. **Admin confidential create**: web UI → `/dashboard/tenant/mcp-clients` → new
   client → confirm client_secret returned, used in `client_secret_post` token
   exchange.
5. **DCR claim flow**: register a public DCR client, claim via consent page,
   verify the post-claim authorize flow still works (existing
   `isDcr && !tenantId` branch in consent/route.ts:103).
6. **Migration replay**: run `npm run db:migrate` on dev DB with confidential
   DCR clients present, then run again. Verify audit_outbox count grows on first
   run and stays flat on second.

## Round-1 review log

See `a07-4-mcp-dcr-public-confidential-review.md`.
