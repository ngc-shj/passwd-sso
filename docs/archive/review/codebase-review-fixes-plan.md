# Plan: codebase-review-fixes

## Project Context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL)
- Test infrastructure: unit + integration (Vitest)
- Branch: `fix/codebase-review-fixes`

## Objective

Address all findings from the full codebase review (2026-04-16). Nine issues identified across audit pipeline, auth migration, SCIM, and admin endpoints.

## Requirements

### Functional

1. Team audit download must enforce `AUDIT_LOG_MAX_ROWS` cap and date boundary
2. Bootstrap tenant migration must fail-closed when tenant has >1 active member
3. Tenant audit action-group merge must not silently overwrite duplicate keys
4. Audit export (CSV/JSONL) must preserve `actorType` and raw `userId`
5. SCIM audit must use UUID sentinel (`SYSTEM_ACTOR_ID`) instead of `"system:scim"`
6. `audit-chain-verify` must signal truncation when row cap is hit
7. Admin/maintenance endpoints should record audit actor as system principal
8. Observability: security-sensitive MCP routes should use `withRequestLog`

### Non-Functional

- All changes backward-compatible (no schema migration required for findings 1-4, 6-8)
- No new dependencies

## Technical Approach

### Finding 1: Team audit download cap

Mirror the pattern from `src/app/api/tenant/audit-logs/download/route.ts`:
- Import `AUDIT_LOG_MAX_ROWS` from `@/lib/validations/common.server`
- Add `remaining = AUDIT_LOG_MAX_ROWS - totalRows` to batch size calculation
- Add loop termination: `totalRows >= AUDIT_LOG_MAX_ROWS`
- Require at least one of `from`/`to` date parameters (400 if both absent)

**Clarification (F2):** Personal download (`/api/audit-logs/download`) already enforces `AUDIT_LOG_MAX_ROWS` (line 163) but does NOT require date params — this is intentional because personal scope is inherently bounded by user. Team download is the only endpoint missing BOTH the row cap AND date boundary.

### Finding 2: Bootstrap tenant migration guard

In `src/auth.ts`, **inside** the `prisma.$transaction()` block (first operation, before any updates):
- Query active member count: `tx.tenantMember.count({ where: { tenantId, deactivatedAt: null } })`
- If count > 1, throw an error and abort migration (fail-closed)
- Log the guard failure for operational visibility

**IMPORTANT (S2):** Guard MUST be inside the transaction to prevent TOCTOU race condition — a concurrent member join between the check and the migration would bypass an external guard.

**Testability (T7):** Extract the guard as a testable helper function `assertBootstrapSingleMember(tx, tenantId)` that can be unit-tested independently from Auth.js callbacks.

### Finding 3: Tenant audit action-group merge

In `src/app/api/tenant/audit-logs/route.ts` (line ~82):
- Replace object spread merge with a function that merges by key using array union (deduplicated via Set)
- Implement the merge helper in `src/lib/constants/audit.ts` as `mergeActionGroups()`

**Spec (F1):** Both `group:admin` AND `group:scim` keys exist in both `AUDIT_ACTION_GROUPS_TENANT` and `AUDIT_ACTION_GROUPS_TEAM`. The merge must produce a Set-based union for both:
- `group:admin` → TENANT actions (TENANT_ROLE_UPDATE, ACCESS_DENIED, HISTORY_PURGE, etc.) + TEAM actions (MASTER_KEY_ROTATION, VAULT_KEY_ROTATION, etc.)
- `group:scim` → Both sides have the same 8 SCIM actions (union is idempotent, but must not drop either side)

**Test location (T4):** Create `src/lib/constants/audit.test.ts` for `mergeActionGroups()` pure function tests.

### Finding 4: Audit export actor fidelity

In all three download routes:
- Add `actorType` column to CSV header and JSONL output
- Use raw `log.userId` instead of resolved `userInfo?.id` for the userId field
- Keep resolved user info in a separate display column (e.g., `userEmail`) for readability

Files:
- `src/app/api/audit-logs/download/route.ts`
- `src/app/api/tenant/audit-logs/download/route.ts`
- `src/app/api/teams/[teamId]/audit-logs/download/route.ts`

### Finding 5: SCIM audit user normalization

Replace `SCIM_SYSTEM_USER_ID = "system:scim"` with `SYSTEM_ACTOR_ID` (UUID sentinel) + `actorType: SYSTEM`:
- Update `src/lib/scim-token.ts`: use `resolveAuditUserId(token.createdById, "system")` from `src/lib/constants/app.ts`
- Remove `SCIM_SYSTEM_USER_ID` constant
- Update all SCIM route `logAuditAsync` calls to include `actorType: "SYSTEM"` when using the fallback
- Update `enforceAccessRestriction` calls in SCIM routes: pass `SYSTEM_ACTOR_ID` as userId AND `token.tenantId` as `tenantIdOverride`
- Update `ValidatedScimToken.auditUserId` JSDoc comment to reference `SYSTEM_ACTOR_ID` instead of `SCIM_SYSTEM_USER_ID`

**IMPORTANT (F6+S5):** SCIM routes currently pass the literal string `"scim"` as the userId parameter to `enforceAccessRestriction()`. Some calls occur BEFORE token validation (e.g., `Users/route.ts:41` GET handler). For pre-validation calls, use `SYSTEM_ACTOR_ID` as userId with `tenantIdOverride` from the SCIM token. Without `tenantIdOverride`, `resolveUserTenantId(SYSTEM_ACTOR_ID)` will return null (sentinel not in users table), causing access restriction to be silently skipped.

Files:
- `src/lib/scim-token.ts` (replace constant + update JSDoc)
- `src/lib/scim-token.test.ts` (update imports and assertions)
- `src/app/api/scim/v2/Users/route.ts`
- `src/app/api/scim/v2/Users/[id]/route.ts`
- `src/app/api/scim/v2/Groups/route.ts`
- `src/app/api/scim/v2/Groups/[id]/route.ts`
- `src/app/api/scim/v2/ResourceTypes/route.ts`
- `src/app/api/scim/v2/Schemas/route.ts`
- `src/app/api/scim/v2/ServiceProviderConfig/route.ts`
- `src/lib/access-restriction.ts` — extend `enforceAccessRestriction` to accept optional `actorType` parameter, so ACCESS_DENIED audit logs record correct actor type (F7). Add defensive guard: when userId is a sentinel UUID (SYSTEM_ACTOR_ID/ANONYMOUS_ACTOR_ID) and tenantIdOverride is missing, fail-closed with 403 (S6)

### Finding 6: Chain-verify truncation signal

In `src/app/api/maintenance/audit-chain-verify/route.ts`:
- Track whether query hit the `MAX_ROWS_PER_REQUEST` limit
- Add `truncated: true` and `verifiedUpToSeq` to response when limit is hit
- Change overall `ok` to `false` when truncated (fail-closed for compliance)
- Add `reason` field to response for machine-readable failure classification: `"TRUNCATED" | "TAMPER_DETECTED" | "GAP_DETECTED" | "TIMESTAMP_VIOLATION"` (S1)
- Add `truncated` and `verifiedUpToSeq` to `logAuditAsync` metadata for the chain-verify audit event (F4)

### Finding 7: Admin/maintenance audit actor binding

In admin-token-authenticated endpoints:
- Record `userId: SYSTEM_ACTOR_ID` and `actorType: "SYSTEM"` in audit logs
- Move `operatorId` to `metadata.operatorId` (informational only, not the audit actor)
- Keep the existing operatorId validation (UUID + DB existence check) for authorization

Files:
- `src/app/api/admin/rotate-master-key/route.ts`
- `src/app/api/maintenance/purge-history/route.ts`
- `src/app/api/maintenance/purge-audit-logs/route.ts`
- `src/app/api/maintenance/audit-outbox-purge-failed/route.ts`
- `src/app/api/maintenance/audit-outbox-metrics/route.ts`
- `src/app/api/maintenance/audit-chain-verify/route.ts`
- `src/app/api/maintenance/dcr-cleanup/route.ts`

### Finding 8: MCP route observability

Wrap with `withRequestLog`:
- `src/app/api/mcp/register/route.ts`
- `src/app/api/mcp/token/route.ts`
- `src/app/api/mcp/route.ts`
- `src/app/api/tenant/mcp-clients/route.ts`
- `src/app/api/tenant/mcp-clients/[id]/route.ts`

## Implementation Steps

1. **Finding 1** — Team audit download: add `AUDIT_LOG_MAX_ROWS` guard + date boundary requirement
2. **Finding 2** — Bootstrap migration: add active member count guard
3. **Finding 3** — Action-group merge: implement `mergeActionGroups()` helper
4. **Finding 4** — Export actor fidelity: add `actorType` + raw `userId` to CSV/JSONL
5. **Finding 5** — SCIM audit normalization: replace `system:scim` with UUID sentinel
6. **Finding 6** — Chain-verify truncation: add `truncated` flag + fail-closed
7. **Finding 7** — Admin audit actor: bind to SYSTEM_ACTOR_ID, operatorId to metadata
8. **Finding 8** — MCP observability: wrap routes with `withRequestLog`
9. **Tests** — Add/update regression tests for each finding
10. **Build verification** — Run lint, tests, and production build

## Testing Strategy

| Finding | Test approach |
|---------|--------------|
| 1 | Import `AUDIT_LOG_MAX_ROWS`, `AUDIT_LOG_BATCH_SIZE` from `@/lib/validations/common.server`. Use `maxBatches = AUDIT_LOG_MAX_ROWS / AUDIT_LOG_BATCH_SIZE` pattern (same as personal download test). Test: (a) stops at MAX_ROWS, (b) 400 when no date params, (c) boundary: remaining=1 last batch |
| 2 | Extract `assertBootstrapSingleMember(tx, tenantId)` helper. Test: (a) count=1 passes, (b) count>1 throws, (c) verify guard runs inside tx |
| 3 | Create `src/lib/constants/audit.test.ts`. Test: (a) duplicate key `group:admin` produces union of both sides, (b) duplicate key `group:scim` produces union, (c) unique keys preserved unchanged |
| 4 | Add mock entries with `userId: SYSTEM_ACTOR_ID, actorType: "SYSTEM"` and `userId: ANONYMOUS_ACTOR_ID, actorType: "ANONYMOUS"`. Assert: (a) CSV header includes `actorType`, (b) JSONL includes `actorType` field, (c) raw `userId` preserved (not resolved user.id), (d) all 3 routes produce identical CSV headers |
| 5 | Replace `SCIM_SYSTEM_USER_ID` import with `SYSTEM_ACTOR_ID` from `@/lib/constants/app`. Assert: `auditUserId === SYSTEM_ACTOR_ID` when `createdById` is null. Add assertion for `actorType: "SYSTEM"` |
| 6 | Test: (a) `truncated: true` AND `ok: false` when row cap hit, (b) `reason: "TRUNCATED"` in response, (c) audit metadata includes `truncated: true` and `verifiedUpToSeq`, (d) normal case returns `ok: true, truncated: false, reason: undefined` |
| 7 | Unit test: admin endpoints record `SYSTEM_ACTOR_ID` as userId in audit, with `metadata.operatorId` containing the original operator UUID |
| 8 | Unit test: MCP routes are wrapped with `withRequestLog` (verify import/usage). Verify rate limiter exists on `/api/mcp/register` |

**Mock shape unification (T6):** When updating team download tests for Finding 4, unify mock shape across JSONL and CSV tests to include `userId`, `actorType` at top level.

**CSV header consistency (T10):** The "identical CSV headers" assertion across 3 routes should use `expect(headers).toEqual(EXPECTED_HEADERS)` for each route independently. If routes intentionally differ (e.g., team-specific columns), document the expected differences rather than asserting equality.

## Considerations & Constraints

- **Finding 5 (SCIM)**: Removing `SCIM_SYSTEM_USER_ID` is a breaking change for any code referencing it. Grep confirms it is only used in `scim-token.ts` and its test file.
- **Finding 7 (admin actor)**: Changing audit `userId` from `operatorId` to `SYSTEM_ACTOR_ID` changes audit trail semantics. The operator identity is preserved in metadata for forensic purposes. Compliance tools that rely on the primary `userId` field for accountability will see `SYSTEM_ACTOR_ID` — downstream integrations (SIEM, audit delivery targets) must be aware of this change and query `metadata.operatorId` for human attribution.
- **Finding 4 (export)**: Adding columns to CSV changes the export schema. Existing parsers that depend on column order should use header-based parsing.
- **No migration needed**: All changes are application-level. `SYSTEM_ACTOR_ID` is already a valid UUID sentinel in `audit_logs.userId` per the audit-path-unification migration.
- **Finding 7 (metadata searchability, S4)**: Current audit log search API may not support filtering by `metadata.operatorId`. Verify during implementation; if not filterable, consider recording `operatorId` in an indexed field (e.g., `targetId` or `targetResource`) as fallback.
- **Finding 8 (MCP rate limiter, S3)**: While adding `withRequestLog`, verify that `/api/mcp/register` (unauthenticated DCR endpoint) has an existing rate limiter. Add IP-based rate limiting if missing.
- **Finding 6 (breaking change, S7)**: Adding `ok: false` for truncation is a breaking change for existing chain-verify clients (SIEM, scripts). Clients must update to check `reason` field to distinguish `TRUNCATED` from `TAMPER_DETECTED`. Document this in the API response and consider a deprecation period or opt-in via query parameter if clients cannot be updated immediately.

## User Operation Scenarios

1. **Tenant admin downloads team audit logs** (Finding 1): Request without date params returns 400. Request with dates + large dataset stops streaming at 100k rows.
2. **First SSO login triggers bootstrap migration** (Finding 2): If somehow a second user exists in the bootstrap tenant, migration aborts with a clear error.
3. **Tenant admin views audit logs with no scope filter** (Finding 3): Both TENANT and TEAM `ADMIN` group actions appear in the filter dropdown. Selecting `group:admin` shows union of both.
4. **Compliance team exports audit logs** (Finding 4): CSV includes `actorType` column. `userId` shows the raw UUID (including sentinels). Resolved email shown in separate column.
5. **SCIM provisioning with deleted token creator** (Finding 5): SCIM operations use `SYSTEM_ACTOR_ID` + `actorType: SYSTEM`. Audit events persist correctly to `audit_logs`.
6. **Auditor verifies chain integrity for large tenant** (Finding 6): Response includes `truncated: true` and `verifiedUpToSeq` when >10k rows. Auditor knows to paginate.
7. **Admin rotates master key** (Finding 7): Audit log shows `userId: SYSTEM_ACTOR_ID`, `actorType: SYSTEM`, `metadata.operatorId: <admin-uuid>`.
8. **MCP client registers** (Finding 8): Request gets correlation ID via `X-Request-Id` header and standardized request/response logging.
