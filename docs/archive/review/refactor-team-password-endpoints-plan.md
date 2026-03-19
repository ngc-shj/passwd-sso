# Plan: refactor-team-password-endpoints

## Objective

Remove redundant cross-team aggregation endpoints (`/api/teams/archived`, `/api/teams/trash`, `/api/teams/favorites`) and switch the UI components to use the existing team-specific endpoint (`/api/teams/[teamId]/passwords`) with query parameters.

## Background

The cross-team aggregation endpoints are only called from within team-specific pages where `teamId` is already known. The team-specific endpoint already supports `?archived=true` and `?trash=true` query parameters, making the aggregation endpoints redundant.

## Requirements

### Functional
- `TeamArchivedList` must fetch archived entries via `GET /api/teams/[teamId]/passwords?archived=true`
- `TeamTrashList` must fetch trashed entries via `GET /api/teams/[teamId]/passwords?trash=true`
- No behavioral regression: existing archive/trash views must display the same data
- Role-gated UI actions (edit, delete, restore, empty trash) must remain functional
- Remove `/api/teams/archived`, `/api/teams/trash`, `/api/teams/favorites` endpoints entirely

### Non-functional
- No new endpoints introduced
- API path constants cleaned up
- All related tests updated or removed
- No over-disclosure of `createdBy.email` in UI

## Technical Approach

### Response Format Differences

The cross-team endpoints return a slightly different shape than the team-specific endpoint:

| Field | Cross-team (`/api/teams/archived`) | Team-specific (`?archived=true`) |
|-------|-------------------------------------|----------------------------------|
| `teamId`, `teamName`, `role` | Included | Not included (implied by URL) |
| `requireReprompt`, `expiresAt` | Not included | Included |
| `deletedAt` | Included (trash only) | Included |
| `createdBy.email` | Not included | Included |

### Key Finding: Components use `teamName` and `role` from response

Both components actively consume `teamName` and `role` from the API response:

- **`TeamArchivedList`**: `entry.teamName` for search filtering (line 199) and rendering (line 465); `entry.role` for `canEdit`/`canDelete` permission checks (lines 463-464)
- **`TeamTrashList`**: `entry.teamName` for rendering (line 378); `entry.role` for empty-trash/restore permission checks (line 382)

**Solution:** Pass `teamName` and `role` as props from the parent team page (which already has this information). Remove `teamName`/`role` from the entry-level data and use the prop values instead. This is cleaner since within a single team page, all entries share the same team name and role.

### Security Improvement

The cross-team endpoints use `withBypassRls` (PostgreSQL RLS bypass). The replacement uses `withTeamTenantRls` (DB-layer tenant isolation). This is a net security improvement.

## Implementation Steps

### Pre-implementation verification

0. **Verify existing test coverage**
   - Confirm `src/app/api/teams/[teamId]/passwords/route.test.ts` has test cases for `?archived=true` and `?trash=true` query params. Add them if absent.
   - Grep to confirm `API_PATH.TEAMS_FAVORITES` has no UI callers other than the three files being deleted.
   - Confirm `createdBy.email` is not rendered by `TeamArchivedList` or `TeamTrashList`.

### Component changes

1. **Modify `TeamArchivedList`** (`src/components/team/team-archived-list.tsx`)
   - Make `teamId` prop required (remove `?`)
   - Add `teamName: string` and `role: string` props
   - Change fetch URL from `API_PATH.TEAMS_ARCHIVED` to `apiPath.teamPasswords(teamId) + "?archived=true"`
   - Replace `entry.teamName` references with the `teamName` prop
   - Replace `entry.role` references with the `role` prop
   - Remove client-side `teamId` filtering logic
   - Remove dead `!scopedTeamId` conditional branches (unreachable after making `teamId` required)

2. **Modify `TeamTrashList`** (`src/components/team/team-trash-list.tsx`)
   - Make `teamId` prop required (remove `?`)
   - Add `teamName: string` and `role: string` props
   - Change fetch URL from `API_PATH.TEAMS_TRASH` to `apiPath.teamPasswords(teamId) + "?trash=true"`
   - Replace `entry.teamName` references with the `teamName` prop
   - Replace `entry.role` references with the `role` prop
   - Remove `scopedRole` derivation block (lines 289-291) — replace with `role` prop directly
   - Remove client-side `teamId` filtering logic
   - Remove dead `!scopedTeamId` conditional branches

3. **Update parent page** (`src/app/[locale]/dashboard/teams/[teamId]/page.tsx`)
   - Guard rendering: only render `TeamArchivedList`/`TeamTrashList` when `team` is loaded (not null), since `teamName` and `role` come from `team` state which is initially null
   - Pass `teamName={team.name}` and `role={team.role}` props to both components
   - Note: `team` state is fetched by `fetchTeam()` on mount; the guard prevents rendering before data is ready. This changes load behavior slightly (archived/trash list waits for team fetch) but is negligible since `fetchTeam` is fast and already runs first.

### Endpoint deletion

4. **Delete cross-team endpoints**
   - Delete `src/app/api/teams/archived/` (route + test)
   - Delete `src/app/api/teams/trash/` (route + test)
   - Delete `src/app/api/teams/favorites/` (route + test)

5. **Clean up API path constants** (`src/lib/constants/api-path.ts`)
   - Remove `TEAMS_ARCHIVED`, `TEAMS_FAVORITES`, `TEAMS_TRASH`
   - Update `api-path.test.ts` accordingly
   - Grep codebase for any remaining references to removed constants

### Test updates

6. **Add/update component tests**
   - Add tests for `TeamArchivedList` asserting correct fetch URL (`apiPath.teamPasswords(teamId) + "?archived=true"`)
   - Add tests for `TeamTrashList` asserting correct fetch URL (`apiPath.teamPasswords(teamId) + "?trash=true"`)
   - Update `team-bulk-wiring.test.ts` if it references removed endpoints or constants
   - Verify no test references removed `API_PATH.TEAMS_ARCHIVED/TRASH/FAVORITES`

## Testing Strategy

- `npx vitest run` — all tests pass
- `npx next build` — production build succeeds (catches TypeScript errors, undefined props)
- Component tests verify correct fetch URL construction
- Grep for `TEAMS_ARCHIVED`, `TEAMS_TRASH`, `TEAMS_FAVORITES` — zero remaining references

## Considerations & Constraints

- The `favorites` scope in the team page already uses `?favorites=true` on the team-specific endpoint, so no UI change needed for favorites
- If a future "cross-team dashboard" is needed, new aggregation endpoints can be designed then with proper RESTful patterns (`/api/teams/passwords?archived=true`)
- No database migration required
- No i18n changes required
- Removing `withBypassRls` usage is a net security improvement
