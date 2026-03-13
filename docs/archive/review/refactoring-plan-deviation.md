# Coding Deviation Log: refactoring-plan
Created: 2026-03-14T01:20:00+09:00

## Deviations from Plan

### DEV-1: P0-4 withRequestLog — health/live intentionally excluded
- **Plan description**: Apply `withRequestLog()` to all route handlers
- **Actual implementation**: Excluded `src/app/api/health/live/route.ts`
- **Reason**: Liveness probe must remain minimal — adding logging wrapper introduces unnecessary overhead and potential failure modes for a health check endpoint
- **Impact scope**: 1 route file; all other 136 routes covered

### DEV-2: P0-4 withRequestLog — global test mock added
- **Plan description**: Apply withRequestLog to all routes
- **Actual implementation**: Added `vi.mock("@/lib/with-request-log")` as passthrough in `src/__tests__/setup.ts`
- **Reason**: Many existing tests call route handlers without request arguments (e.g., `GET()` with no args). The withRequestLog wrapper accesses `request.headers` which would crash. Passthrough mock allows existing tests to continue working. The dedicated `with-request-log.test.ts` uses `vi.unmock` to test real behavior.
- **Impact scope**: All route handler tests; health/ready test's X-Request-Id assertion removed (tested in dedicated test file)

### DEV-3: SCIM routes — explicit return type annotations added
- **Plan description**: Mechanical withRequestLog wrapping
- **Actual implementation**: Added `Promise<Response>` return type annotations and `as Response` / `as Exclude<...>` type assertions in SCIM Groups and Users route handlers
- **Reason**: TypeScript inference limitation with complex `withTenantRls` + try/catch + discriminated union return types. Pre-existing issue exposed by the `RouteHandler` type constraint.
- **Impact scope**: `src/app/api/scim/v2/Groups/[id]/route.ts`, `src/app/api/scim/v2/Users/[id]/route.ts`

### DEV-4: Item 6 parseBody — partial rollout (44 of 72 routes)
- **Plan description**: Create shared body parsing utility and apply to all routes
- **Actual implementation**: Applied to 44 routes total (29 initial + 12 Type A + 2 Type B + 1 Type C)
- **Reason**: Remaining 26 routes cannot be mechanically migrated:
  - Type D (8): Multi-step/manual validation without Zod schemas — requires new schema creation
  - Type E (4): No schema validation at all — requires try/catch + Zod schema addition
  - Type F (5): SCIM endpoints use `scimError()` protocol-specific responses — incompatible with `parseBody`
  - Other (9): `admin/rotate-master-key` + `passwords/generate` + bulk operation routes with custom validation
- **Impact scope**: 28 routes still use inline body parsing. Type B migration changed error code from `INVALID_BODY` to `VALIDATION_ERROR` (with details) in 2 routes (audit-logs/import, audit-logs/export). 2 Type B routes (vault/admin-reset, auth/passkey/options/email) reverted to inline parsing per security review — these are security-sensitive/unauthenticated endpoints where schema detail leakage is unacceptable

### DEV-5: Implementation scope — P1-P3 items deferred
- **Plan description**: Implement all 19 items
- **Actual implementation**: Completed Items 1-4 (P0) and Item 6 (P1 parseBody). Items 5, 7-19 deferred.
- **Reason**: Items 5, 7-8 (P1) and 9-19 (P2-P3) involve complex architectural changes (auth unification, VaultContext split, entry type definitions, form hook generalization) that each warrant their own PR with dedicated review cycles. Batching them risks review fatigue and merge conflicts.
- **Impact scope**: N/A — deferred work, no code changes

---
