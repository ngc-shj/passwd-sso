# Full Codebase Review (2026-04-16)

- Scope: Whole-codebase static review with risk-based decomposition
- Method: Code reading + targeted cross-file consistency checks
- Note: Runtime test execution is not included in this pass

## Decomposition

1. Audit domain (API/list/download, actor identity, group filtering)
2. Auth and tenant migration domain
3. External HTTP/security boundary (SSRF and outbound delivery)
4. Test coverage and regression-risk checks

## Findings (Severity Order)

### 1) High - Team audit download is effectively unbounded

`GET /api/teams/[teamId]/audit-logs/download` does not enforce a row cap (`AUDIT_LOG_MAX_ROWS`) and does not require a date boundary. On large datasets, this can produce long-lived streaming responses and sustained DB pressure.

Evidence:
- `src/app/api/teams/[teamId]/audit-logs/download/route.ts:21`
- `src/app/api/teams/[teamId]/audit-logs/download/route.ts:74`
- `src/app/api/teams/[teamId]/audit-logs/download/route.ts:148`
- `src/app/api/teams/[teamId]/audit-logs/download/route.ts:202`

Contrast (bounded implementations):
- `src/app/api/tenant/audit-logs/download/route.ts:18`
- `src/app/api/tenant/audit-logs/download/route.ts:124`
- `src/app/api/audit-logs/download/route.ts:16`
- `src/app/api/audit-logs/download/route.ts:163`

Recommendation:
- Apply `AUDIT_LOG_MAX_ROWS` guard in team download loop.
- Require `from` or `to` (or enforce bounded default window).

### 2) High - Bootstrap tenant migration relies on an unenforced single-user invariant

During first SSO migration, several updates are scoped only by `tenantId` (not by actor user), while code comments assume bootstrap tenants are single-user.
If that invariant is ever violated (data issue, manual operation, future feature drift), migration can move other members' tenant-scoped data to a different tenant.

Evidence:
- `src/auth.ts:92`
- `src/auth.ts:109`
- `src/auth.ts:111`
- `src/auth.ts:118`
- `prisma/schema.prisma:408`
- `prisma/schema.prisma:431`

Recommendation:
- Add a runtime guard before migration: assert the bootstrap tenant has exactly one active member.
- Fail closed if membership count > 1.
- Consider DB-level guardrails where feasible, or a hard operational invariant check in migration path.

### 3) Medium - Tenant audit action-group merge drops tenant-only actions

When scope is not explicitly fixed, group maps are merged using object spread:
`{ ...AUDIT_ACTION_GROUPS_TENANT, ...AUDIT_ACTION_GROUPS_TEAM }`.
Duplicate keys (for example `group:admin`) are overwritten by TEAM groups, which can hide tenant-only actions in grouped filtering.

Evidence:
- `src/app/api/tenant/audit-logs/route.ts:82`
- `src/lib/constants/audit.ts:431`
- `src/lib/constants/audit.ts:503`

Recommendation:
- Merge by key with array union (de-duplicated), not last-writer-wins spread.

### 4) Medium - Audit export payload does not preserve actor semantics

CSV/JSONL download payloads omit `actorType`, and CSV `userId` uses resolved user lookup (`userInfo?.id`) instead of raw `log.userId`. Sentinel/system/anonymous actors can lose forensic meaning in exported data.

Evidence:
- `src/app/api/tenant/audit-logs/download/route.ts:27`
- `src/app/api/tenant/audit-logs/download/route.ts:152`
- `src/app/api/tenant/audit-logs/download/route.ts:163`
- `src/app/api/teams/[teamId]/audit-logs/download/route.ts:31`
- `src/app/api/audit-logs/download/route.ts:24`

Recommendation:
- Add `actorType` to CSV/JSONL output.
- Export raw `log.userId` separately from resolved user object.

### 5) High - SCIM audit fallback userId is not UUID, causing silent audit dead-letter

SCIM token validation returns `auditUserId = createdById ?? "system:scim"`.
`logAuditAsync` requires UUID-compatible `userId` for outbox delivery, and the worker rejects non-UUID userId for non-SYSTEM actor payloads.
As a result, SCIM audit events can be dropped into dead-letter instead of being persisted to `audit_logs`.

Evidence:
- `src/lib/scim-token.ts:11`
- `src/lib/scim-token.ts:119`
- `src/lib/audit.ts:5`
- `src/lib/audit.ts:39`
- `src/workers/audit-outbox-worker.ts:967`
- `src/app/api/scim/v2/Users/route.ts:243`
- `src/app/api/scim/v2/Users/[id]/route.ts:126`
- `src/app/api/scim/v2/Groups/[id]/route.ts:108`

Recommendation:
- Replace `SCIM_SYSTEM_USER_ID` with a UUID sentinel (`SYSTEM_ACTOR_ID`) and set `actorType: SYSTEM` where appropriate.
- Add regression tests ensuring SCIM audit writes survive when token creator is missing.

### 6) Medium - SCIM access restriction denial audit can use non-UUID userId

SCIM routes call `enforceAccessRestriction(req, "scim", tenantId)`.
On deny paths, `enforceAccessRestriction` writes `ACCESS_DENIED` using that raw `userId`, which is non-UUID and can fail audit outbox processing for the same reason.

Evidence:
- `src/app/api/scim/v2/Users/route.ts:41`
- `src/lib/access-restriction.ts:223`
- `src/workers/audit-outbox-worker.ts:967`

Recommendation:
- For SCIM routes, pass a UUID sentinel user (`SYSTEM_ACTOR_ID`) and explicit actor type where needed, or add a SCIM-safe audit helper that normalizes actor identity.

### 7) Low - Observability inconsistency: several security-sensitive API routes skip `withRequestLog`

A subset of API routes are not wrapped by `withRequestLog`, so request correlation (`X-Request-Id`) and standardized start/end/error logs are missing for those endpoints.
This is mainly an operations/debuggability risk.

Examples:
- `src/app/api/mcp/register/route.ts`
- `src/app/api/mcp/token/route.ts`
- `src/app/api/mcp/route.ts`
- `src/app/api/tenant/mcp-clients/route.ts`
- `src/app/api/tenant/mcp-clients/[id]/route.ts`

Recommendation:
- Wrap these routes with `withRequestLog` (except intentionally noisy/liveness endpoints if excluded by policy).

### 8) High - `audit-chain-verify` can return false confidence due to hard row cap truncation

`GET /api/maintenance/audit-chain-verify` declares full chain verification semantics, but internally applies `LIMIT 10000`. When a tenant has more than 10,000 chain rows in the requested range, the endpoint can return `ok: true` after checking only the first page, without signaling truncation/incompleteness.

Evidence:
- `src/app/api/maintenance/audit-chain-verify/route.ts:28`
- `src/app/api/maintenance/audit-chain-verify/route.ts:234`
- `src/app/api/maintenance/audit-chain-verify/route.ts:247`
- `src/app/api/maintenance/audit-chain-verify/route.ts:314`

Recommendation:
- Implement batched pagination loop until `toSeq` is fully covered.
- Or explicitly return a `truncated: true`/`incomplete: true` flag and fail closed for compliance usage.
- Add tests for >10,000-row tenant chains with tamper injected after first page.

### 9) Medium - Admin/maintenance endpoints trust caller-supplied `operatorId` (audit actor spoofable)

Multiple admin-token endpoints accept `operatorId` from request body/query and only check that it belongs to an active tenant admin. Because identity is not cryptographically bound to the bearer credential, any holder of `ADMIN_API_TOKEN` can attribute operations to another admin user in audit logs.

Evidence:
- `src/app/api/admin/rotate-master-key/route.ts:36`
- `src/app/api/admin/rotate-master-key/route.ts:112`
- `src/app/api/maintenance/purge-history/route.ts:26`
- `src/app/api/maintenance/purge-audit-logs/route.ts:26`
- `src/app/api/maintenance/audit-outbox-purge-failed/route.ts:25`
- `src/app/api/maintenance/audit-outbox-metrics/route.ts:22`
- `src/app/api/maintenance/audit-chain-verify/route.ts:35`
- `src/app/api/maintenance/dcr-cleanup/route.ts:26`

Recommendation:
- Stop accepting free-form `operatorId` as actor identity.
- Record actor as a fixed system principal for admin-token flows, and move `operatorId` to optional metadata only.
- If human attribution is required, replace static admin token with per-operator auth (session/OIDC/service account) and bind actor from credential, not request payload.

## Areas Reviewed With No New Findings In This Pass

- External outbound delivery SSRF defenses and secret scrubbing:
  - `src/lib/external-http.ts`
- Webhook dispatcher retry/signing/IP pinning flow:
  - `src/lib/webhook-dispatcher.ts`
- MCP OAuth core validation (code exchange, refresh rotation, revocation):
  - `src/lib/mcp/oauth-server.ts`
- Share-link content/download access-token enforcement and view-count atomics:
  - `src/app/api/share-links/verify-access/route.ts`
  - `src/app/api/share-links/[id]/content/route.ts`
  - `src/app/s/[token]/download/route.ts`
- Middleware CORS/security-header baseline behavior:
  - `src/lib/cors.ts`
  - `src/lib/security-headers.ts`
  - `src/proxy.ts`
- Terraform baseline network/database posture:
  - `infra/terraform/network.tf`
  - `infra/terraform/database.tf`
- Docker compose local/prod separation and exposed-port comments:
  - `docker-compose.yml`
  - `docker-compose.override.yml`
- Core auth middleware + parsing utilities:
  - `src/lib/check-auth.ts`
  - `src/lib/parse-body.ts`
  - `src/lib/admin-token.ts`
- CLI and browser extension security-sensitive paths (token handling, bridge, TLS mode):
  - `cli/src/lib/api-client.ts`
  - `cli/src/lib/oauth.ts`
  - `extension/src/content/token-bridge-lib.ts`
  - `extension/src/background/index.ts`

## Test Gap Notes

- Team audit download tests currently cover pagination behavior but not hard-cap termination equivalent to `AUDIT_LOG_MAX_ROWS`.
  - `src/app/api/teams/[teamId]/audit-logs/download/route.test.ts`
- Action-group merge collision case (tenant + team same group key) lacks direct regression test.
  - `src/app/api/tenant/audit-logs/route.test.ts`
- Export schema assertions do not validate `actorType`/raw `userId` preservation for sentinel actors.
  - `src/app/api/audit-logs/download/route.test.ts`
  - `src/app/api/tenant/audit-logs/download/route.test.ts`
  - `src/app/api/teams/[teamId]/audit-logs/download/route.test.ts`
- Bootstrap migration lacks an explicit regression test for "bootstrap tenant has multiple active members" fail-closed behavior.
  - `src/auth.test.ts`
- SCIM audit fallback path lacks regression tests for non-UUID actor fallback handling.
  - `src/lib/scim-token.ts`
  - `src/app/api/scim/v2/Users/route.test.ts`
  - `src/app/api/scim/v2/Users/[id]/route.test.ts`
  - `src/app/api/scim/v2/Groups/[id]/route.test.ts`

## Proposed Fix Order

1. Add team download cap/date bound (High)
2. Add bootstrap migration guard (`activeMemberCount === 1`) and fail-closed path (High)
3. Fix tenant action-group merge semantics (Medium)
4. Expand export schema for actor fidelity (Medium)
5. Fix SCIM audit user normalization (`system:scim` and `"scim"` call-sites) (High/Medium)
6. Fix `audit-chain-verify` truncation semantics (High)
7. Bind admin/maintenance audit actor identity to credential (Medium)
8. Add focused regression tests for the above

## Coverage Completion (This Pass)

- [x] API surface (`src/app/api`) sampled across personal/team/tenant/admin/scim/mcp/v1
- [x] Auth and access-restriction core (`src/lib/check-auth.ts`, `src/lib/access-restriction.ts`)
- [x] Audit pipeline core (`src/lib/audit.ts`, outbox workers, maintenance verify/purge routes)
- [x] External delivery/security boundary (`src/lib/external-http.ts`, webhook dispatcher, CORS/headers/proxy)
- [x] Infra/IaC baseline (`infra/terraform`, docker compose)
- [x] CLI / Extension token-flow and bridge-path spot checks
- [x] Regression-test gap scan for high/medium findings
