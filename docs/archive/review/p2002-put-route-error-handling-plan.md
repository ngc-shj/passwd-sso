# Plan: P2002 PUT Route Error Handling

## Objective

Add P2002 (unique constraint violation) error handling as a safety net to all PUT route handlers that perform `prisma.*.update()` on models with `@@unique` constraints. This prevents unhandled 500 responses from race conditions where manual duplicate checks pass but the DB constraint still catches a conflict.

## Requirements

### Functional
- All PUT routes with unique-constrained models must catch Prisma P2002 errors and return 409
- Existing manual duplicate checks remain in place (defense in depth)
- Each route returns the appropriate existing error code (FOLDER_ALREADY_EXISTS, TAG_ALREADY_EXISTS)
- Add corresponding test cases for each route

### Non-functional
- Follow the established pattern from `src/app/api/tenant/service-accounts/[id]/route.ts` L111-144
- No behavior change for happy path

## Technical Approach

Wrap the `withUserTenantRls(...)` / `withTeamTenantRls(...)` call (NOT the inner prisma call) in a try-catch that handles `Prisma.PrismaClientKnownRequestError` with code `P2002`, returning 409 with the appropriate error code.

### Reference implementation (`src/app/api/tenant/service-accounts/[id]/route.ts` L111-144)
```typescript
import { Prisma } from "@prisma/client";

let sa;
try {
  sa = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.update({ ... }),
  );
} catch (err) {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    return NextResponse.json(
      { error: API_ERROR.SA_NAME_CONFLICT },
      { status: 409 },
    );
  }
  throw err;
}
```

**Important**: The try-catch wraps the entire RLS wrapper call (`withUserTenantRls` / `withTeamTenantRls`), not the inner `prisma.*.update()`. P2002 bubbles up through the transaction/RLS wrapper.

## Target Routes

| # | Route file | Model | Unique constraint | Error code | Test file |
|---|-----------|-------|-------------------|-----------|-----------|
| 1 | `src/app/api/folders/[id]/route.ts` | Folder | `[name, parentId, userId]` | `FOLDER_ALREADY_EXISTS` | `src/__tests__/api/folders/folder-by-id.test.ts` |
| 2 | `src/app/api/teams/[teamId]/folders/[id]/route.ts` | TeamFolder | `[name, parentId, teamId]` | `FOLDER_ALREADY_EXISTS` | `src/__tests__/api/teams/team-folder-by-id.test.ts` |
| 3 | `src/app/api/teams/[teamId]/tags/[id]/route.ts` | TeamTag | `[name, parentId, teamId]` | `TAG_ALREADY_EXISTS` | `src/app/api/teams/[teamId]/tags/[id]/route.test.ts` |

All 3 routes already have manual duplicate checks before the update. The P2002 catch is a DB-level safety net for race conditions.

### Excluded Routes (unique constraint fields are immutable in PUT handler)
- `src/app/api/teams/[teamId]/route.ts` — Team `@@unique([tenantId, slug])` — slug is NOT updated
- `src/app/api/directory-sync/[id]/route.ts` — DirectorySyncConfig `@@unique([tenantId, provider])` — provider is NOT updated

## Implementation Steps

1. Add `import { Prisma } from "@prisma/client"` to routes 1-3
2. Wrap `withUserTenantRls(...)` call in `src/app/api/folders/[id]/route.ts` with P2002 catch → 409 `FOLDER_ALREADY_EXISTS`
3. Wrap `withTeamTenantRls(...)` call in `src/app/api/teams/[teamId]/folders/[id]/route.ts` with P2002 catch → 409 `FOLDER_ALREADY_EXISTS`
4. Wrap `withTeamTenantRls(...)` call in `src/app/api/teams/[teamId]/tags/[id]/route.ts` with P2002 catch → 409 `TAG_ALREADY_EXISTS`
5. Add P2002 test case to each route's test file (see Testing Strategy)

## Testing Strategy

For each of the 3 routes, add a test case that:
1. Sets up prior mocks so the manual duplicate check passes (findUnique/findFirst return valid existing record, no duplicate found)
2. Mocks the update to throw `PrismaClientKnownRequestError` with code `P2002`
3. Asserts 409 status with correct error code

**Important**: The folder/tag routes have multi-step flows (findUnique → findFirst duplicate check → update). The P2002 test must mock the prior steps to pass successfully, otherwise the test will hit the manual 409 from the duplicate check rather than the P2002 catch.

Reference test: `src/app/api/tenant/service-accounts/[id]/route.test.ts` L203-224

## Considerations & Constraints

- Manual duplicate checks remain as the primary defense; P2002 catch is the DB-level safety net
- Error codes `FOLDER_ALREADY_EXISTS` and `TAG_ALREADY_EXISTS` already exist in `src/lib/api-error-codes.ts`
- Routes 4-5 are explicitly excluded because their unique constraint fields are immutable in the PUT handler
- `src/lib/prisma-error.ts` has a generic `mapPrismaError` but returns generic codes — we use specific error codes per route

## User Operation Scenarios

- Two users simultaneously rename different folders to the same name under the same parent → one succeeds, the other gets 409 instead of 500
- Concurrent tag rename to a conflicting name → same behavior
- These are rare edge cases that only occur under concurrent writes, but returning 500 is incorrect behavior
