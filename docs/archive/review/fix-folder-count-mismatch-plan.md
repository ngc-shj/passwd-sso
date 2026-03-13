# Plan: fix-folder-count-mismatch

## Objective

Fix inconsistency between entry count displayed in sidebar folders/tags and the actual entries shown when selected. Also prevent this class of bug from recurring.

## Requirements

### Functional
- Folder/tag count in sidebar must match the number of entries displayed when the folder/tag is selected
- Counts must exclude soft-deleted entries (`deletedAt != null`)
- Counts must exclude archived entries (`isArchived: true`) in the default (non-archived) view
- Team password count in team detail endpoint must also exclude deleted/archived entries

### Non-functional
- Shared filter constant to ensure count queries and list queries always use the same conditions
- Test coverage to verify count/list filter consistency at the endpoint level

## Root Cause Analysis

The list query for entries (`GET /api/passwords`, `GET /api/teams/[teamId]/passwords`) filters by:
```
{ deletedAt: null, isArchived: false }
```

But some count queries use different filters:

| Location | Count Filter | List Filter | Mismatch |
|----------|-------------|-------------|----------|
| `/api/folders` | `{ deletedAt: null }` | `{ deletedAt: null, isArchived: false }` | Missing `isArchived: false` |
| `/api/teams/[teamId]/folders` | `{ deletedAt: null }` | `{ deletedAt: null, isArchived: false }` | Missing `isArchived: false` |
| `/api/teams/[teamId]` (passwordCount) | No filter | `{ deletedAt: null, isArchived: false }` | No filter at all |
| `/api/tags` | `{ deletedAt: null, isArchived: false }` | `{ deletedAt: null, isArchived: false }` | OK |
| `/api/teams/[teamId]/tags` | `{ deletedAt: null, isArchived: false }` | `{ deletedAt: null, isArchived: false }` | OK |
| `/api/v1/tags` | `{ deletedAt: null, isArchived: false }` | `{ deletedAt: null, isArchived: false }` | OK |

## Technical Approach

### 1. Shared filter constant (prevention)

Create a shared constant `ACTIVE_ENTRY_WHERE` in `src/lib/prisma-filters.ts`:
```typescript
/**
 * Standard Prisma where clause for "active" entries (not deleted, not archived).
 * Used in both _count queries and list queries to ensure consistency.
 *
 * WARNING: Changing this constant affects ALL count and list queries across
 * personal/team endpoints. Verify both count and list behavior after changes.
 *
 * DO NOT use in: emergency-access vault entries, rotate-key endpoints
 * (these intentionally include archived entries).
 */
export const ACTIVE_ENTRY_WHERE = { deletedAt: null, isArchived: false };
```

Note: Do NOT use `as const` — use a plain object so TypeScript infers compatible types when spread into both `PasswordEntry` and `TeamPasswordEntry` where clauses.

### 2. Fix affected endpoints

- `src/app/api/folders/route.ts` — change count filter to `ACTIVE_ENTRY_WHERE`
- `src/app/api/teams/[teamId]/folders/route.ts` — change count filter to `ACTIVE_ENTRY_WHERE`
- `src/app/api/teams/[teamId]/route.ts` — add `ACTIVE_ENTRY_WHERE` filter to password count (use `{ passwords: { where: { ...ACTIVE_ENTRY_WHERE } } }` syntax for `_count.select`)
- `src/app/api/tags/route.ts` — refactor to use `ACTIVE_ENTRY_WHERE` (already correct, but use shared constant)
- `src/app/api/teams/[teamId]/tags/route.ts` — refactor to use `ACTIVE_ENTRY_WHERE`
- `src/app/api/v1/tags/route.ts` — refactor to use `ACTIVE_ENTRY_WHERE`

### 3. Refactor list queries to use shared constant

- `src/app/api/passwords/route.ts` — use `ACTIVE_ENTRY_WHERE` as base for default view
- `src/app/api/teams/[teamId]/passwords/route.ts` — same

### 4. Explicit exclusion list (DO NOT apply `ACTIVE_ENTRY_WHERE`)

The following endpoints intentionally include archived entries and must NOT be refactored:
- `/api/emergency-access/[id]/vault/entries` — grantee needs all non-deleted entries including archived
- `/api/vault/rotate-key` related endpoints — key rotation must re-encrypt all entries

## Implementation Steps

1. Create `src/lib/prisma-filters.ts` with `ACTIVE_ENTRY_WHERE` constant (plain object, with JSDoc)
2. Update `/api/folders/route.ts` — use `{ ...ACTIVE_ENTRY_WHERE }` in `_count.select.entries.where`
3. Update `/api/teams/[teamId]/folders/route.ts` — use `{ ...ACTIVE_ENTRY_WHERE }` in `_count.select.entries.where`
4. Update `/api/teams/[teamId]/route.ts` — change `_count: { select: { passwords: true } }` to `_count: { select: { members: true, passwords: { where: { ...ACTIVE_ENTRY_WHERE } } } }`
5. Update `/api/tags/route.ts` — replace inline `{ deletedAt: null, isArchived: false }` with `{ ...ACTIVE_ENTRY_WHERE }` in `_count`
6. Update `/api/teams/[teamId]/tags/route.ts` — same as step 5
7. Update `/api/v1/tags/route.ts` — same as step 5
8. Update `/api/passwords/route.ts` — use `...ACTIVE_ENTRY_WHERE` as base for default view filter
9. Update `/api/teams/[teamId]/passwords/route.ts` — same as step 8
10. Add/update endpoint tests to verify `_count` where arguments include both `deletedAt: null` and `isArchived: false`
11. Verify `?tree=true` tag query path still returns correct counts
12. Run `npx vitest run` and `npx next build`

## Testing Strategy

### Endpoint-level tests (primary)
- Update `src/app/api/folders/route.test.ts` GET test: assert `findMany` is called with `include._count.select.entries.where` matching `{ deletedAt: null, isArchived: false }`
- Update `src/app/api/teams/[teamId]/folders/route.test.ts` GET test: same assertion
- Update `src/app/api/teams/[teamId]/route.test.ts` GET test: assert `findUnique` select includes `_count.select.passwords.where` matching the filter
- Verify existing tag endpoint tests still pass (already correct filter)

### Constant shape test (supplementary)
- `src/lib/__tests__/prisma-filters.test.ts`: verify `ACTIVE_ENTRY_WHERE` has exactly `{ deletedAt: null, isArchived: false }`

### Tree view regression test
- Verify `/api/tags?tree=true` returns correct `passwordCount` values

### Build verification
- Run existing test suite and production build

## Considerations & Constraints

- The shared constant only covers the "active entries in default view" case. Trash view and archive view use different filters by design.
- Emergency access and key rotation endpoints are explicitly excluded.
- Plain object (not `as const`) ensures TypeScript compatibility across `PasswordEntry` and `TeamPasswordEntry` model types.
- Existing tag count queries are already correct but should be refactored to use the shared constant for consistency and prevention.
- Existing bug in emergency access RLS context (`withUserTenantRls` uses grantee instead of owner) is out of scope — tracked separately.
