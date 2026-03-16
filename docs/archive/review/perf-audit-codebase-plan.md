# Plan: perf-audit-codebase

## Objective

Audit the entire codebase for performance improvement opportunities beyond what was addressed in PR #209 (DB access loop optimizations). Identify and fix inefficient patterns across API routes, middleware, library utilities, and client-side code.

## Requirements

### Functional
- All existing tests must continue to pass
- No behavioral changes to API responses
- Audit logging must remain intact (per-entry logs preserved where required)

### Non-functional
- Reduce DB round-trips in identified hot paths
- Eliminate unnecessary sequential queries
- Reduce per-request overhead in middleware/proxy
- Improve client-side responsiveness

## Technical approach

- Add `select` clauses to reduce fetched columns
- Use `Promise.all` to parallelize independent queries
- Add `take` limits to unbounded queries
- Batch audit log writes where possible
- Optimize hot-path middleware operations
- Fix client-side re-render/re-fetch patterns

## Implementation steps

### Priority High — Hot-path and high-impact (6 issues)

1. **Team password history — missing take limit** (`src/app/api/teams/[teamId]/passwords/[id]/history/route.ts` L41)
   - Add `take: 20` matching personal history pattern from PR #209

2. **logAudit tenantId resolution queries** (`src/lib/audit.ts` L82-98)
   - Audit callers that don't pass `tenantId` — add `tenantId` to call sites where it's already known
   - Eliminates 1-2 extra DB queries per audit log write
   - **Must be implemented before Item 3** (createMany depends on tenantId being available)

3. **Bulk ops per-entry logAudit N-loop** (6 bulk-archive/restore/trash routes)
   - Replace `for (entryId of entryIds) { logAudit(...) }` with single `auditLog.createMany` inside a separate `withBypassRls` call (NOT inside the main data transaction — audit logs must survive main tx rollback)
   - All fields from individual `logAudit` calls must be preserved: scope, action, userId, teamId, targetType, targetId, metadata, ip, userAgent, tenantId
   - Eliminates N separate `withBypassRls` + transaction per entry

4. **Password history routes — parallelize entry + history lookups** (6 handlers across 4 files)
   - **GET handlers only** (entry is used only for ownership check):
     - `src/app/api/passwords/[id]/history/[historyId]/route.ts` GET
     - `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route.ts` GET
   - **PATCH handlers** (entry used for ownership check, history used for keyVersion comparison):
     - `src/app/api/passwords/[id]/history/[historyId]/route.ts` PATCH
     - `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route.ts` PATCH
     - Note: entry and history are both needed before validation but are independent lookups → parallelize
   - **NOT applicable to restore routes** — restore needs the full entry object for history snapshot inside the subsequent transaction. Parallelizing provides no benefit since entry must be fully loaded.

5. **Webhook dispatcher — parallel delivery with concurrency limit** (`src/lib/webhook-dispatcher.ts` L130-173)
   - Replace `for (const webhook of webhooks)` with concurrent delivery
   - Use `Promise.allSettled` with concurrency limit (max 5) to prevent resource exhaustion
   - Each webhook can take up to 31s with retries; serial = N * 31s worst case

6. **Rate limiter Redis round-trips** (`src/lib/rate-limit.ts` L35-42)
   - Combine `INCR` + `PEXPIRE` into a single Redis pipeline or Lua script
   - Add `PTTL` to same pipeline when rate-limited

### Priority Medium — Sequential queries, missing select (12 issues)

7. **Emergency access routes — parallelize independent lookups**
   - `[id]/request/route.ts` L72-87: owner + grantee lookups → `Promise.all`
   - `route.ts` POST L43-64: duplicate check + operator lookup → combine into single RLS call

8. **Sends routes — parallelize lookups**
   - `sends/route.ts` POST: actor tenantId lookup independent of validation
   - `sends/file/route.ts` POST L103-148: aggregate + actor → `Promise.all`

9. **Team password service — parallelize validation queries**
   - `createTeamPassword` L220-239: team + folder lookups → `Promise.all`
   - `updateTeamPassword` L377-388: team + folder lookups → `Promise.all`

10. **Emergency access routes — missing select** (4 files)
    - `[id]/approve/route.ts` L29: add `select` (only needs id, ownerId, granteeId, status)
    - `[id]/request/route.ts` L35: add `select` (only needs granteeId, status, ownerId, waitDays)
    - `[id]/decline/route.ts`: verify and add `select`
    - `[id]/revoke/route.ts`: verify and add `select`

11. **Restore routes — missing select** (2 files)
    - `passwords/[id]/restore/route.ts` L23: add `select: { userId: true, deletedAt: true }`
    - `teams/[teamId]/passwords/[id]/restore/route.ts` L33: add `select: { teamId: true, deletedAt: true }`

12. **History restore routes — missing select** (2 files)
    - `passwords/[id]/history/[historyId]/restore/route.ts` L24, L37: add `select` for needed fields
    - `teams/[teamId]/passwords/[id]/history/[historyId]/restore/route.ts` L33, L43: same

13. **Other missing select**
    - `teams/[teamId]/members/[memberId]/route.ts` DELETE L169: add `select`
    - `teams/invitations/accept/route.ts` L67: add `select: { deactivatedAt: true, scimManaged: true }`
    - `v1/passwords/[id]/route.ts` DELETE L254: add `select: { userId: true }`

14. **Team favorite route — collapse 3 queries** (`teams/[teamId]/passwords/[id]/favorite/route.ts` L32-83)
    - Include `favorites` relation in entry query to eliminate separate findUnique
    - Use `deleteMany` with count check instead of findUnique + delete

15. **Confirm-key route — collapse sequential lookups** (`teams/[teamId]/members/[memberId]/confirm-key/route.ts` L40-57)
    - Include `user: { select: { ecdhPublicKey: true } }` in member query

16. **V1 PUT — history + update in separate transactions** (`v1/passwords/[id]/route.ts` L155-208)
    - Wrap history snapshot + entry update in single transaction (matching pattern in personal PUT handler)

### Priority Low — Middleware, infra, client-side (6 issues)

17. **Proxy CSP header rebuild** (`proxy.ts` L43-67)
    - Pre-build CSP template at module init; only inject nonce per-request

18. **Proxy hashCookie optimization** (`src/proxy.ts` L271-276)
    - Extract session token from cookie instead of hashing entire cookie string
    - Eliminates SHA-256 computation per request

19. **Proxy session cache eviction** (`src/proxy.ts` L261-269)
    - Replace `sessionCache.clear()` with LRU eviction (delete oldest entries)

20. **Client: PasswordList search re-fetch** (`src/components/passwords/password-list.tsx` L120-219)
    - Remove `searchQuery` from `useCallback` deps; filter decrypted entries with `useMemo`

22. **Client: PasswordDashboard constant re-creation** (`src/components/passwords/password-dashboard.tsx` L74-108)
    - Move `ENTRY_TYPE_ICONS`/`ENTRY_TYPE_TITLES` to module scope or `useMemo`

## Testing strategy

- All existing Vitest tests must pass (`npx vitest run`)
- Production build must succeed (`npx next build`)
- Lint must pass (`npm run lint`)

## Considerations & constraints

- **No behavioral changes**: API responses must remain identical
- **Audit log completeness**: per-entry audit logs must be preserved; `createMany` must include all fields that individual `logAudit` calls produce (scope, action, userId, teamId, targetType, targetId, metadata, ip, userAgent). Verify by comparing audit log count before/after in tests
- **Client-side changes**: Must not break vault unlock flow or crypto operations. When removing `searchQuery` from `useCallback` deps, verify no stale closure over decrypted data
- **Proxy changes**: Must work in both Edge and Node.js runtime
- **Webhook parallelization**: Must handle individual webhook failures without affecting others (use `Promise.allSettled` with concurrency limit of 5)
- **Priority Low items**: Evaluate ROI before implementing — some may not justify the complexity
