# Plan: optimize-db-access-loops

## Objective

Optimize application-level DB access patterns to reduce unnecessary round-trips, eliminate N+1 queries, and improve resource efficiency across all API route handlers.

## Requirements

### Functional
- All existing tests must continue to pass
- No behavioral changes to API responses
- Audit logging must remain intact

### Non-functional
- Reduce DB round-trips in identified hot paths
- Eliminate N+1 query patterns in SCIM and directory sync
- Parallelize independent sequential queries
- Add `select` clauses to avoid fetching unnecessary columns
- Remove redundant re-fetch queries

## Technical approach

- Use Prisma `select` to fetch only needed columns
- Use `Promise.all` to parallelize independent queries
- Use `createMany` / `updateMany` for batch operations
- Use relation includes to eliminate separate queries
- Add `take` limits where business logic caps results
- Pre-fetch data outside loops to eliminate N+1 patterns

## Implementation steps

### Priority High — N+1 / Loop queries (3 issues)

1. **SCIM Group PUT — replaceScimGroup loop queries** (`src/lib/services/scim-group-service.ts` L239-280)
   - Pre-fetch all `teamMember` rows with `userId: { in: toAdd }` and `teamId` inside the transaction
   - Pre-fetch all `tenantMember` rows similarly
   - **OWNER protection**: Check pre-fetched members for `role === OWNER`; throw `ScimOwnerProtectedError` if any OWNER is in toAdd
   - Separate existing members (update) from new members (createMany)
   - All pre-fetches and writes must include `tenantId` in where clauses

2. **SCIM Group PATCH — patchScimGroup loop queries** (`src/lib/services/scim-group-service.ts` L347-389)
   - Same approach as #1: pre-fetch inside transaction, OWNER protection, batch writes with tenantId scoping

3. **Directory Sync engine loop queries** (`src/lib/directory-sync/engine.ts` L407-509)
   - Pre-fetch all `user` rows by email in one `findMany`
   - Pre-fetch all `tenantMember` rows by tenantId
   - Use `updateMany` for batch deactivation with `id: { in: [...] }` AND `role: { not: "OWNER" }` in where clause
   - **OWNER protection in toUpdate path**: When IdP sets `active=false` for a user, skip deactivation if the user's role is OWNER (add `if (member.role === "OWNER" && !pu.active) continue` guard in the toUpdate loop, or filter at toUpdate list construction)
   - Keep pre-fetch + write in same `$transaction` block

### Priority Medium — Sequential → Parallel, Redundant queries, Batch opportunities (5 issues)

4. **Sessions GET — 3 sequential queries** (`src/app/api/sessions/route.ts` L28-60)
   - Merge session token lookup into sessions `findMany` by selecting `sessionToken`
   - Run sessions list and tenant policy fetch in parallel with `Promise.all`
   - **Null guard**: Use `currentToken ? query : Promise.resolve(null)` pattern
   - **Security**: Ensure `sessionToken` is NOT included in API response — use only for internal comparison

5. **Team invitations POST — 4 sequential queries** (`src/app/api/teams/[teamId]/invitations/route.ts` L85-128)
   - Parallelize user lookup, invitation check, and team fetch with `Promise.all`

6. **Bulk operations redundant re-fetch** (6 files: bulk-archive, bulk-restore, bulk-trash for personal and team)
   - Wrap first `findMany` + `updateMany` in a single `$transaction` to ensure atomicity
   - Remove the third `findMany` — use `entryIds` from the first query directly (atomicity guaranteed by transaction)

7. **Empty trash — findMany + deleteMany** (2 files: personal and team empty-trash)
   - Keep the existing `$transaction` pattern; the `findMany` is needed for audit log entry IDs

8. **Rotate-key — individual creates** (`src/app/api/teams/[teamId]/rotate-key/route.ts` L196-213)
   - Replace individual `create` calls with `createMany` for `teamMemberKey`
   - Use `skipDuplicates: false` (explicit) and assert `createMany.count === memberKeys.length`

### Priority Low — Missing select, Join opportunities, Limits (12 issues)

9. **SCIM Groups list — batch loadGroupMembers** (`src/app/api/scim/v2/Groups/route.ts` L103-112, `src/lib/services/scim-group-service.ts` L103-111)
   - Existing code already uses `Promise.all` for parallel queries — optimization benefit is limited
   - If proceeding: batch-fetch all teamMembers with `OR` filter including `tenantId`, then group in-memory

10. **Password PUT — missing select** (`src/app/api/passwords/[id]/route.ts` L75-79)
    - Add `select` for only used fields (userId, tenantId, encryptedBlob, blobIv, blobAuthTag, keyVersion, aadVersion)

11. **Password DELETE — missing select** (`src/app/api/passwords/[id]/route.ts` L215-219)
    - Add `select: { userId: true }`

12. **SCIM patchScimUser — missing select** (`src/lib/services/scim-user-service.ts` L244)
    - Add `select: { id: true, role: true, deactivatedAt: true }`

13. **SCIM deactivateScimUser — missing select** (`src/lib/services/scim-user-service.ts` L302-305)
    - Replace `include` with `select: { id: true, role: true, user: { select: { email: true } } }`

14. **Auth adapter updateSession — sequential queries** (`src/lib/auth-adapter.ts` L292-327)
    - Include `tenant` relation in initial session fetch to eliminate separate query

15. **Share link DELETE — extra teamId query** (`src/app/api/share-links/[id]/route.ts` L62-69)
    - Include `teamPasswordEntry: { select: { teamId: true } }` in initial share fetch

16. **Password history — no limit** (`src/app/api/passwords/[id]/history/route.ts` L34-38)
    - Add `take: 20` to match business limit

17. **Team members POST — redundant queries** (`src/app/api/teams/[teamId]/members/route.ts` L112-134)
    - Collapse user existence + tenant membership check into single `tenantMember.findFirst`

18. **Rotate-key — unbounded findMany** (`src/app/api/teams/[teamId]/rotate-key/route.ts` L135-137)
    - Use `count` first, then only load IDs if count matches

19. **Directory sync — missing select on tenantMember** (`src/lib/directory-sync/engine.ts` L295-300)
    - Replace `include` with `select` for only used fields

20. **Rotate-key — individual updateMany per entry** (`src/app/api/teams/[teamId]/rotate-key/route.ts` L161-192)
    - Skip: each entry has unique ciphertext; `Promise.all` already mitigates. Raw SQL CASE WHEN is fragile.

## Testing strategy

- All existing Vitest tests must pass (`npx vitest run`)
- Production build must succeed (`npx next build`)
- Lint must pass (`npm run lint`)
- **New test files required:**
  - `src/lib/services/scim-group-service.test.ts`: Unit tests for `replaceScimGroup` and `patchScimGroup`
    - Multi-member simultaneous add/remove
    - Mixed add + remove operations
    - OWNER role protection (must throw ScimOwnerProtectedError)
    - Duplicate userId handling
    - Mid-operation error rollback
  - `src/lib/directory-sync/engine.test.ts`: Unit tests for `runDirectorySync`
    - dryRun mode (no writes)
    - Safety guard trigger (force=false and force=true)
    - Lock contention (acquired=false)
    - Stale lock reset
    - Batch deactivation with OWNER exclusion
    - toUpdate path OWNER protection (IdP sets active=false for OWNER)
    - Error propagation from Promise.all
- Update `vitest.config.ts` `coverage.include` to add `src/lib/services/scim-group-service.ts` and `src/lib/directory-sync/engine.ts`
- Manual verification of SCIM, directory sync, and team operations if possible

## Considerations & constraints

- **No behavioral changes**: API responses must remain identical
- **Transaction safety (TOCTOU)**: Pre-fetching outside transactions introduces TOCTOU risk. Mitigations: (a) write operations inside the transaction must re-validate ownership/state via where clauses (e.g., `where: { id: { in: ids }, tenantId }`), (b) for SCIM/directory-sync where correctness is critical, keep pre-fetch + write in the same `$transaction` block
- **Tenant isolation in batch operations**: All `createMany` / `updateMany` / `deleteMany` where clauses must include `tenantId` (or equivalent scoping) to prevent cross-tenant data leakage
- **OWNER role protection**: Batch operations must preserve existing OWNER protection checks. For SCIM: pre-fetch roles and validate before batch writes. For directory sync: include `role: { not: "OWNER" }` in updateMany where clause
- **Prisma createMany limitations**: Cannot return created records; acceptable where return values aren't needed. Always verify count matches expected
- **Issue #20 skipped**: Per-entry unique ciphertext makes true batching impractical without raw SQL; current `Promise.all` is acceptable
- **Audit logging**: This project uses explicit `logAudit()` function calls (not Prisma middleware), so `createMany`/`updateMany` do not bypass audit logging. Per-entry audit events must be preserved where they exist
- **select clause safety**: When adding `select`, verify all downstream field accesses are covered to prevent runtime errors
