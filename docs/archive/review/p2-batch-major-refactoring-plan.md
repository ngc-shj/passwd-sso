# P2 Batch: Major Refactoring (Items 13, 14, 15, 16)

## Objective

Complete the four P2 (High Cost / High Impact) refactoring items as a single batch:
- **Item 13**: Generalize Personal/Team Form Hooks
- **Item 14**: Reduce Prop Drilling in Password Components
- **Item 15**: Extract Business Logic from Large API Routes
- **Item 16**: Standardize Error Response Contract

## Requirements

### Functional Requirements

1. **Item 13 — Generalize Form Hooks**: Reduce 42+ personal/team form hook files to ~25 shared files with scope-parameterized configuration. Currently LOGIN is the only entry type with form hooks; other types (CREDIT_CARD, IDENTITY, etc.) are defined but not yet implemented. The refactoring must:
   - Preserve per-scope validation messages and default values
   - Preserve async side-effects (debounced API calls, auto-save)
   - Handle encryption difference: personal uses client-side `CryptoKey`, team uses server-side encryption via `submitEntry` callback. The `FormScopeConfig.encrypt` field must use a discriminated union (`{ scope: "personal"; encryptionKey: CryptoKey }` | `{ scope: "team"; submitEntry: SubmitEntryFn }`) — NOT a generic function type — to prevent cross-scope misuse at compile time
   - Maintain entry-type-specific field sets
   - Keep snapshot baseline tests passing
   - Add integration tests verifying that debounced API calls and auto-save side-effects fire correctly after unification

2. **Item 14 — Reduce Prop Drilling**: Restructure `PasswordCardProps` (31 props) into grouped objects. Currently 3 call sites (password-list.tsx, team-archived-list.tsx, team page) each manually map 20+ props. The refactoring must:
   - Group props into: `entry` (display data), `handlers` (callbacks), `permissions` (RBAC), `fetchers` (team data providers)
   - No JSX spread patterns exist — all explicit prop passing
   - Update all 3 caller sites
   - Preserve team vs personal mode behavior
   - Replace implicit `isTeamMode` detection (`!!getPasswordProp`) with explicit `mode: "personal" | "team"` prop to prevent false-positive team mode detection after fetchers grouping
   - Callers must memoize grouped prop objects (`useMemo` for `entry`/`permissions`/`fetchers`, `useCallback` for handlers) to avoid unnecessary re-renders. `PasswordCard` should be wrapped with `React.memo`
   - Create `password-card.test.tsx` baseline tests before refactoring (minimum 3 cases: render, callback invocation, expand toggle)

3. **Item 15 — Extract API Services**: Move business logic from SCIM routes (471 + 421 lines) and team password routes (252 + 364 lines) into `src/lib/services/`. Route handlers should only handle HTTP concerns. The refactoring must:
   - Keep auth checks in route handlers (never in services)
   - Service functions require `authenticatedUserId`/`authenticatedTenantId` as mandatory parameter — use branded type `type AuthenticatedTenantId = string & { __brand: "AuthenticatedTenantId" }` to prevent accidental unvalidated usage
   - Preserve existing response shapes and status codes
   - Add explicit `tenantId` filter to queries (defense-in-depth)
   - Audit logging must remain in route handlers (not services) — services are pure data operations
   - Service modules must NOT be exported from package entry points — keep as internal imports only

4. **Item 16 — Standardize Error Responses**: Unify error response creation. `api-error-codes.ts` already defines 67 error codes, but routes use `NextResponse.json({ error: ... })` directly with inconsistent patterns. The refactoring must:
   - Create `errorResponse(code, status, details?)` helper
   - Phase A: Define helper alongside existing patterns
   - Phase B: Migrate routes in batches
   - Preserve all existing error codes and status mappings
   - **SCIM routes are excluded** — SCIM uses RFC 7644-defined error format via existing `scimError()` helper; do not replace with the new generic helper

### Non-Functional Requirements

- All tests must pass (`npx vitest run`)
- Production build must succeed (`npx next build`)
- No breaking changes to external API contracts (v1 REST API, SCIM)
- No changes to authentication/authorization behavior

## Technical Approach

### Implementation Order and Dependencies

```
Phase 1: Item 16 (Error Response) — foundation, no dependencies
Phase 2: Item 14 (Prop Drilling) — independent, uses existing types from src/types/entry.ts
Phase 3: Item 15 (API Services) — uses Item 16's createErrorResponse
Phase 4: Item 13 (Form Hooks) — largest, benefits from Item 14's structured entry types
```

### Item 16: Error Response Contract

**Current state**: 67 error codes in `src/lib/api-error-codes.ts`. Routes use `NextResponse.json({ error: API_ERROR.X }, { status: N })` directly. `TeamAuthError` class exists as a structured exception pattern.

**Pre-requisite**: Change `TeamAuthError.message` type from `string` to `ApiErrorCode` to ensure type compatibility with `errorResponse()`. Update all `throw new TeamAuthError(...)` call sites. This must be done at the start of Phase 1.

**Approach**:
1. Create `src/lib/api-response.ts` with:
   ```typescript
   export function errorResponse(
     code: ApiErrorCode,
     status: number,
     details?: Record<string, unknown>
   ): NextResponse {
     return NextResponse.json(
       details ? { error: code, ...details } : { error: code },
       { status }
     );
   }
   ```
2. Add common presets for frequent patterns:
   ```typescript
   export const unauthorized = () => errorResponse(API_ERROR.UNAUTHORIZED, 401);
   export const notFound = () => errorResponse(API_ERROR.NOT_FOUND, 404);
   export const forbidden = () => errorResponse(API_ERROR.FORBIDDEN, 403);
   export const validationError = (details: unknown) =>
     errorResponse(API_ERROR.VALIDATION_ERROR, 400, { details });
   ```
3. Migrate routes in batches — start with team routes (preparing for Item 15), then remaining. **SCIM routes are excluded** (use existing `scimError()` helper per RFC 7644)

**Files to create**:
- `src/lib/api-response.ts`
- `src/lib/api-response.test.ts`

**Files to modify**: ~80+ route files (phased migration)

### Item 14: Reduce Prop Drilling

**Current state**: `PasswordCardProps` has 31 props. 3 call sites each manually map all props.

**Approach**:
1. Define grouped interfaces in `src/types/entry.ts` (extend existing file):
   ```typescript
   // Display fields extracted from encrypted overview
   export interface EntryOverviewData {
     id: string;
     entryType?: EntryTypeValue;
     title: string;
     username: string | null;
     urlHost: string | null;
     snippet?: string | null;
     // ... entry-type-specific display fields
     tags: EntryTagNameColor[];
     isFavorite: boolean;
     isArchived: boolean;
     requireReprompt?: boolean;
     expiresAt?: string | null;
   }

   export interface PasswordCardHandlers {
     onToggleFavorite: (id: string, current: boolean) => void;
     onToggleArchive: (id: string, current: boolean) => void;
     onDelete: (id: string) => void;
     onToggleExpand: (id: string) => void;
     onRefresh: () => void;
     onEditClick?: () => void;
   }

   export interface PasswordCardPermissions {
     canEdit?: boolean;
     canDelete?: boolean;
   }

   export interface PasswordCardFetchers {
     getPassword?: () => Promise<string>;
     getDetail?: () => Promise<InlineDetailData>;
     getUrl?: () => Promise<string | null>;
   }

   export interface PasswordCardProps {
     entry: EntryOverviewData;
     expanded: boolean;
     handlers: PasswordCardHandlers;
     permissions?: PasswordCardPermissions;
     fetchers?: PasswordCardFetchers;
     createdBy?: string | null;
     teamId?: string;
   }
   ```
2. Update `password-card.tsx` to destructure from grouped props
3. Update 3 call sites: `password-list.tsx`, `team-archived-list.tsx`, `teams/[teamId]/page.tsx`
4. Update `DisplayEntry`, `TeamPasswordEntry`, `TeamArchivedEntry` internal types to align with `EntryOverviewData`

**Files to modify**:
- `src/types/entry.ts` (add interfaces)
- `src/components/passwords/password-card.tsx` (restructure props)
- `src/components/passwords/password-list.tsx` (update caller)
- `src/components/team/team-archived-list.tsx` (update caller)
- `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` (update caller)

### Item 15: Extract API Services

**Current state**: SCIM routes (471 + 421 lines) and team password routes (252 + 364 lines) have business logic mixed with HTTP handling. No `src/lib/services/` directory exists.

**Approach**:
1. Create `src/lib/services/` directory
2. Extract SCIM user business logic:
   ```typescript
   // src/lib/services/scim-user-service.ts
   export async function getScimUser(tenantId: string, userId: string): Promise<ScimUserResource | null>
   export async function updateScimUser(tenantId: string, userId: string, data: ScimUserUpdate): Promise<ScimUserResource>
   export async function patchScimUser(tenantId: string, userId: string, operations: ScimPatchOp[]): Promise<ScimUserResource>
   export async function deleteScimUser(tenantId: string, userId: string): Promise<void>
   ```
3. Extract SCIM group business logic:
   ```typescript
   // src/lib/services/scim-group-service.ts
   export async function getScimGroup(tenantId: string, groupId: string): Promise<ScimGroupResource | null>
   export async function updateScimGroup(tenantId: string, groupId: string, data: ScimGroupUpdate): Promise<ScimGroupResource>
   export async function patchScimGroup(tenantId: string, groupId: string, operations: ScimPatchOp[]): Promise<ScimGroupResource>
   export async function deleteScimGroup(tenantId: string, groupId: string): Promise<void>
   ```
4. Extract team password business logic:
   ```typescript
   // src/lib/services/team-password-service.ts
   export async function listTeamPasswords(teamId: string, userId: string, params: ListParams): Promise<TeamPasswordListResult>
   export async function createTeamPassword(teamId: string, userId: string, data: CreateTeamPasswordInput): Promise<TeamPassword>
   export async function getTeamPassword(teamId: string, userId: string, passwordId: string): Promise<TeamPassword | null>
   export async function updateTeamPassword(teamId: string, userId: string, passwordId: string, data: UpdateTeamPasswordInput): Promise<TeamPassword>
   export async function deleteTeamPassword(teamId: string, userId: string, passwordId: string): Promise<void>
   ```

**Auth boundary rule**: All service functions require `tenantId` or `userId` as first parameter. Auth checks (`validateScimToken`, `requireTeamPermission`) stay in route handlers.

**RLS rule**: All service functions that perform Prisma queries must be called within `withTenantRls()` or `withUserTenantRls()` context. Document this requirement in each service file header.

**Audit logging pattern**: Route handlers must wrap service calls in `try/finally` to guarantee audit log recording regardless of errors:
```typescript
let result;
try {
  result = await service.doSomething(tenantId, ...);
} finally {
  await logAudit({ ..., success: result != null });
}
```

**Files to create**:
- `src/lib/services/scim-user-service.ts`
- `src/lib/services/scim-user-service.test.ts`
- `src/lib/services/scim-group-service.ts`
- `src/lib/services/scim-group-service.test.ts`
- `src/lib/services/team-password-service.ts`
- `src/lib/services/team-password-service.test.ts`

**Files to modify**:
- `src/app/api/scim/v2/Users/[id]/route.ts` (slim down to HTTP layer)
- `src/app/api/scim/v2/Groups/[id]/route.ts` (slim down to HTTP layer)
- `src/app/api/teams/[teamId]/passwords/route.ts` (slim down)
- `src/app/api/teams/[teamId]/passwords/[id]/route.ts` (slim down)

### Item 13: Generalize Form Hooks

**Current state**: 24 personal form hook files + 18 team form hook files + 8 shared infrastructure files = 50 total. Only LOGIN entry type has form hooks. Team initial values file pre-defines fields for all entry types.

**Approach**:
1. Create scope-parameterized configuration:
   ```typescript
   // src/hooks/form/form-scope-config.ts
   export interface FormScopeConfig {
     scope: "personal" | "team";
     encrypt: PersonalEncryptFn | TeamSubmitEntryFn;
     tagType: "personal" | "team";
     folderField: "folderId" | "teamFolderId";
     // scope-specific hooks
     sideEffects?: FormSideEffects;
   }
   ```
2. Create unified form hooks:
   ```typescript
   // src/hooks/form/use-login-form-model.ts (replaces both personal and team variants)
   export function useLoginFormModel(config: FormScopeConfig, options: LoginFormOptions)
   ```
3. Create unified controller and presenter:
   ```typescript
   // src/hooks/form/login-form-controller.ts
   export function buildLoginFormController(config: FormScopeConfig, args: LoginFormControllerArgs)

   // src/hooks/form/login-form-presenter.ts
   export function buildLoginFormPresenter(config: FormScopeConfig, args: LoginFormPresenterArgs)
   ```
4. Keep scope-specific adapter files thin:
   ```typescript
   // src/hooks/form/personal-login-adapter.ts
   export function usePersonalLoginForm(options: PersonalLoginFormOptions) {
     const config = createPersonalScopeConfig(options);
     return useLoginFormModel(config, options);
   }
   ```

**Snapshot baseline requirement**: Before merging, create snapshot tests for each form variant's initial state, validation outputs, and onSave call signatures. Use `toMatchInlineSnapshot()`.

**Files to create**:
- `src/hooks/form/form-scope-config.ts`
- `src/hooks/form/use-login-form-model.ts`
- `src/hooks/form/use-login-form-model.test.ts`
- `src/hooks/form/login-form-controller.ts`
- `src/hooks/form/login-form-controller.test.ts`
- `src/hooks/form/login-form-presenter.ts`
- `src/hooks/form/login-form-presenter.test.ts`
- `src/hooks/form/login-form-derived.ts`
- `src/hooks/form/login-form-initial-values.ts`
- `src/hooks/form/personal-login-adapter.ts`
- `src/hooks/form/team-login-adapter.ts`

**Files to deprecate (keep as re-exports during migration)**:
- All `personal-login-form-*.ts` files (redirect to unified)
- All `team-login-form-*.ts` files (redirect to unified)

## Implementation Steps

### Phase 1: Item 16 — Error Response Helper (Steps 1-5)

1. Change `TeamAuthError.message` type from `string` to `ApiErrorCode`; update all `throw new TeamAuthError(...)` call sites
2. Create `src/lib/api-response.ts` with `errorResponse()` helper and common presets (`unauthorized`, `notFound`, `forbidden`, `validationError`)
3. Create `src/lib/api-response.test.ts` with unit tests: verify response body shape, status codes, details inclusion (including `VALIDATION_ERROR` with `details.fieldErrors`), preset helpers
4. Migrate team password routes to use `errorResponse()`:
   - `src/app/api/teams/[teamId]/passwords/route.ts`
   - `src/app/api/teams/[teamId]/passwords/[id]/route.ts`
5. Migrate remaining routes in batches (alphabetical by path):
   - Batch A: `/api/api-keys/*`, `/api/audit-logs/*`, `/api/emergency-access/*`
   - Batch B: `/api/extension/*`, `/api/folders/*`, `/api/passwords/*`
   - Batch C: `/api/sends/*`, `/api/share-links/*`, `/api/tags/*`
   - Batch D: `/api/teams/*` (non-password routes), `/api/tenant/*`, `/api/user/*`, `/api/vault/*`, `/api/watchtower/*`, `/api/webauthn/*`

### Phase 2: Item 14 — Prop Drilling Reduction (Steps 7-11)

7. Create `password-card.test.tsx` baseline tests (render, callback invocation, expand toggle) — must pass before any refactoring
8. Define `EntryOverviewData`, `PasswordCardHandlers`, `PasswordCardPermissions`, `PasswordCardFetchers` interfaces in `src/types/entry.ts`; add explicit `mode: "personal" | "team"` field
9. Refactor `PasswordCardProps` in `password-card.tsx` to use grouped interfaces; replace `!!getPasswordProp` team detection with explicit `mode` prop; update internal destructuring
10. Update callers:
    - `password-list.tsx`: construct `EntryOverviewData` from `DisplayEntry`, pass grouped props with `mode: "personal"`
    - `team-archived-list.tsx`: construct from `TeamArchivedEntry`, pass grouped props with `mode: "team"`
    - `teams/[teamId]/page.tsx`: construct from `TeamPasswordEntry`, pass grouped props with `mode: "team"`
11. Run tests (including new baseline tests) and build to verify no regressions

### Phase 3: Item 15 — Service Extraction (Steps 12-16)

12. Create `src/lib/services/` directory and SCIM user service (`scim-user-service.ts`) — extract GET/PUT/PATCH/DELETE business logic from `Users/[id]/route.ts`
13. Create SCIM group service (`scim-group-service.ts`) — extract from `Groups/[id]/route.ts`
14. Create team password service (`team-password-service.ts`) — extract from team password routes
15. Write service-level tests (mock Prisma) — each service function requires minimum 2 test cases: (a) success path with expected return shape, (b) Prisma error path with expected error transformation
16. Slim down route handlers to HTTP-only concerns (auth → validate → call service within `withTenantRls` → audit log in try/finally → format response)

### Phase 4: Item 13 — Form Hook Generalization (Steps 17-23)

17. Add missing `generatorSettings` change detection test to `personal-login-form-derived.test.ts` (baseline must pass before changes)
18. Create snapshot baseline tests for existing personal and team login form hooks on current code (must pass before any changes)
19. Create `src/hooks/form/form-scope-config.ts` with `FormScopeConfig` interface using discriminated union for encrypt — team scope type must NOT include `encryptionKey` field
20. Create unified `use-login-form-model.ts` that accepts `FormScopeConfig` — implement by extracting common logic from `use-personal-login-form-model.ts` and `use-team-login-form-model.ts`
21. Create unified controller, presenter, derived, and initial-values files
22. Create thin adapter files (`personal-login-adapter.ts`, `team-login-adapter.ts`) that wire scope-specific config
23. Update old files to re-export from unified modules; update component imports; verify snapshot tests still pass

### Phase Gates

After each phase, run the full test suite (`npx vitest run`) and production build (`npx next build`). Both must pass before proceeding to the next phase. Commit at each phase boundary.

### Final Steps

24. Run full test suite (`npx vitest run`) and production build (`npx next build`)
25. Clean up any deprecated re-export files that have zero direct importers

## Testing Strategy

### Unit Tests
- **Item 16**: `api-response.test.ts` — verify response shape, status codes, details merging
- **Item 14**: Existing password-card tests + visual regression (manual)
- **Item 15**: Service tests with mocked Prisma — verify query correctness, return shapes, error handling
- **Item 13**: Snapshot baselines (before), unified hook tests (after), adapter integration tests

### Integration Tests
- Existing route tests must continue passing (they test the full request→response cycle)
- SCIM route tests validate auth + business logic + response format

### Build Verification
- `npx next build` after each phase to catch SSR/bundling issues

## Considerations & Constraints

### Risks
- **Item 13 (High)**: Largest refactoring — 50 files involved. Snapshot baselines are critical before changes
- **Item 15 (Medium)**: SCIM routes have complex auth (Bearer token, not session). Auth must never move to services
- **Item 14 (Medium)**: 3 call sites with extensive prop mapping. TypeScript will catch mismatches at build time
- **Item 16 (Low)**: Mechanical replacement with helper function. Low risk of behavior change

### Out of Scope
- Creating form hooks for non-LOGIN entry types (CREDIT_CARD, IDENTITY, etc.) — Item 13 only unifies existing LOGIN hooks
- Removing `TeamAuthError` class — keep as-is, it works well
- Changing SCIM error format (`scimError()` helper) — SCIM has its own RFC-defined format
- External API contract changes (v1 REST API response shapes)

### Dependencies
- Item 16 should be done before Item 15 (services use the error helper)
- Item 14 can proceed independently
- Item 13 should be last (largest, benefits from stabilized types)
