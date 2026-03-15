# Plan: Optimize DB Indexes

## Objective

Improve database query performance by aligning Prisma schema indexes with actual query patterns used across API routes.

## Requirements

### Functional
- All existing API behavior must remain unchanged
- No schema model changes (fields, relations) — index-only changes
- Migration must be non-destructive (CREATE INDEX, not ALTER TABLE)

### Non-functional
- Reduce unnecessary full-table scans and sort operations
- Composite indexes should follow leftmost-prefix rule
- Avoid index bloat: remove redundant or low-selectivity single-column indexes

## Technical Approach

Analyzed all `prisma.*.findMany()`, `count()`, `groupBy()`, `deleteMany()` calls across `src/app/api/` and `src/lib/services/` to map WHERE clauses, ORDER BY, and filter patterns to existing indexes.

### Changes

| Model | Before | After | Query pattern |
|---|---|---|---|
| Session | `[userId]` | `[userId, expires]` | `WHERE userId AND expires > now()` |
| PasswordEntry | `[userId]` | `[userId, deletedAt, isArchived]` | `WHERE userId AND deletedAt IS NULL AND isArchived = false` |
| TeamPasswordEntry | `[teamId]` | `[teamId, deletedAt]` | `WHERE teamId AND deletedAt` (list + purge) |
| AuditLog | `[userId, createdAt]` / `[teamId, createdAt]` / `[tenantId]` | `[userId, scope, createdAt DESC]` / `[teamId, scope, createdAt DESC]` / `[tenantId, scope, createdAt DESC]` | All audit queries filter by scope + ORDER BY createdAt DESC |
| PasswordShare | `[shareType]` + `[createdById]` | `[createdById, createdAt DESC]` | shareType has low selectivity; /mine queries by createdById + ORDER BY createdAt DESC |
| EmergencyAccessGrant | `[ownerId]` + `[status]` | `[ownerId, status]` | Duplicate check uses WHERE ownerId AND status NOT IN (...) |

## Implementation Steps

1. Update composite indexes in `prisma/schema.prisma`
2. Remove redundant single-column indexes (`shareType`, standalone `status`)
3. Validate schema with `npx prisma validate`
4. Generate client with `npx prisma generate`
5. Verify build with `npx next build`
6. Run full test suite with `npx vitest run`

## Testing Strategy

- `npx prisma validate` — schema correctness
- `npx prisma generate` — client generation
- `npx vitest run` — all 4551 tests must pass (no runtime behavior change)
- `npx next build` — production build must succeed

## Considerations & Constraints

- **Migration**: `npm run db:migrate` will be needed to apply index changes to the actual database. This plan only changes the schema definition.
- **Index size**: Adding columns to indexes increases write overhead slightly, but read performance gains far outweigh this for the query patterns identified.
- **No GIN/pg_trgm indexes**: Team member search uses ILIKE which requires pg_trgm extension for index support. This is out of scope as it requires a PostgreSQL extension change.
- **rotate-key N+1**: Entry updates in rotate-key are inherently per-entry (different data per entry). Max 1000 entries enforced by validation schema.
