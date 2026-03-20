# Plan: refactor-purge-history-admin-auth

## Context

`POST /api/maintenance/purge-history` is currently a user-scoped endpoint (session auth, each user purges only their own history). This is architecturally wrong — history purging is a system-wide maintenance task that should run as a single cron job, not per-user. The endpoint should follow the same admin token auth pattern as `rotate-master-key`.

## Requirements

- Replace session auth with `ADMIN_API_TOKEN` bearer token auth
- Purge ALL users' history across ALL tenants (system-wide)
- Accept `operatorId` in request body for audit trail (same pattern as `rotate-master-key`)
- Accept optional `retentionDays` parameter (default 90, min 1, max 3650)
- Accept optional `dryRun` parameter (default false) — returns count without deleting
- Validate `operatorId` is an active tenant admin (not just any existing user)
- Use `withBypassRls` instead of `withUserTenantRls`
- Change audit scope from PERSONAL to TENANT
- Provide a cron-friendly shell script

## Technical Approach

### Extract `verifyAdminToken` to shared module

Currently inlined in `rotate-master-key`. With a second consumer, extract to `src/lib/admin-token.ts`.

### Auth model change

| Aspect | Before | After |
|--------|--------|-------|
| Auth | Session (`auth()`) | Bearer `ADMIN_API_TOKEN` |
| Scope | User's own history | All history, all tenants |
| RLS | `withUserTenantRls` | `withBypassRls` |
| Rate limit key | `rl:purge_history:${userId}` | `rl:admin:purge-history` |
| Audit scope | PERSONAL | TENANT |
| Body params | (none) | `{ operatorId, retentionDays?, dryRun? }` |

### Query change

```diff
- entry: { userId: session.user.id },
- changedAt: { lt: ninetyDaysAgo },
+ changedAt: { lt: cutoffDate },
```

Remove the `userId` filter entirely — system-wide purge.

## Implementation Steps

1. **Create `src/lib/admin-token.ts`** — extract `verifyAdminToken()` + `HEX64_RE` from `rotate-master-key/route.ts`

2. **Update `src/app/api/admin/rotate-master-key/route.ts`** — replace inline `verifyAdminToken` with import from `@/lib/admin-token`; remove `HEX64_RE` and `verifyAdminToken` function

3. **Update `src/lib/constants/audit.ts`** — add `HISTORY_PURGE` to `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` (line 396). Keep existing PERSONAL/TEAM entries.

4. **Rewrite `src/app/api/maintenance/purge-history/route.ts`**:
   - Bearer token auth via `verifyAdminToken`
   - Body schema: `{ operatorId: string, retentionDays?: z.number().int().min(1).max(3650).default(90), dryRun?: z.boolean().default(false) }`
   - Validate `operatorId` via `withBypassRls` + `prisma.tenantMember.findFirst`:
     - `where: { userId: operatorId, role: { in: ["OWNER", "ADMIN"] }, deactivatedAt: null }`
     - `select: { tenantId: true, role: true }`
     - Returns 400 if no matching active admin membership found
   - Build `whereClause` once: `{ changedAt: { lt: cutoffDate } }` — shared between count and delete
   - If `dryRun`: `prisma.passwordEntryHistory.count({ where: whereClause })`, return `{ purged: 0, matched: count, dryRun: true }`
   - If not `dryRun`: `prisma.passwordEntryHistory.deleteMany({ where: whereClause })`, return `{ purged: deleted.count }`
   - Audit (skip on dryRun): `scope: TENANT`, `userId: operatorId`, `tenantId: membership.tenantId`, metadata: `{ purgedCount, retentionDays, systemWide: true }`

5. **Update `scripts/check-bypass-rls.mjs`** — add `purge-history/route.ts` to bypass-rls allowlist

6. **Rewrite `src/app/api/maintenance/purge-history/route.test.ts`** — test cases:
   - 401: No Authorization header
   - 401: Invalid (non-hex) token
   - 401: `verifyAdminToken` returns false (mock `@/lib/admin-token`)
   - 429: Rate limited
   - 400: Missing `operatorId`
   - 400: `operatorId` does not exist
   - 400: `operatorId` exists but `tenantMember` has MEMBER role (not admin)
   - 400: `operatorId` has admin role but `deactivatedAt` is non-null
   - 200: Purge success — verify `deleteMany` called with no `userId` filter, correct cutoff date
   - 200: Custom `retentionDays` — verify cutoff date is ~30 days ago when `retentionDays: 30`
   - 200: `dryRun: true` — verify `deleteMany` NOT called, `count` called, response has `matched` field
   - 200: Default `retentionDays` (90) — verify cutoff date ~90 days ago
   - Audit: verify `scope: TENANT`, `tenantId`, `userId: operatorId`, metadata contains `purgedCount`
   - Audit: verify NO audit log on `dryRun: true`

7. **Create `scripts/purge-history.sh`** — cron-friendly wrapper:
   - Reads `ADMIN_API_TOKEN`, `APP_URL`, `OPERATOR_ID`, `RETENTION_DAYS` from env vars only (no CLI args for token)
   - Supports `DRY_RUN=true` env var
   - Exit codes: 0=success, 1=error
   - No `set -x` (token leak prevention)

8. **Update `CLAUDE.md`** — update API endpoint description for purge-history

## Testing Strategy

- `npx vitest run` — all tests pass
- `npx next build` — production build succeeds
- `scripts/check-bypass-rls.mjs` passes

## Considerations

- `ADMIN_API_TOKEN` env var is already optional in `env.ts` — no change needed there
- Past audit logs recorded as PERSONAL scope remain unchanged (no retroactive migration)
- PERSONAL/TEAM HISTORY groups keep `HISTORY_PURGE` for potential future per-user/team use
- `tenantId` in audit log is the operator's tenant; `systemWide: true` in metadata clarifies cross-tenant scope
