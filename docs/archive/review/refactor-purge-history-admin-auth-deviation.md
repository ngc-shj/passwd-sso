# Coding Deviation Log: refactor-purge-history-admin-auth
Created: 2026-03-20

## Deviations from Plan

### DEV-001: HEX64_RE consolidated to validations/common.ts (not admin-token.ts)
- **Plan description**: Extract `HEX64_RE` into `src/lib/admin-token.ts` as a local constant
- **Actual implementation**: Canonical definition placed in `src/lib/validations/common.ts`, imported by `admin-token.ts`, `base-cloud-provider.ts`, and `env.ts`. Eliminated 4 duplicate definitions.
- **Reason**: User requested consolidation of duplicated `HEX64_RE` across the codebase. `validations/common.ts` already hosts shared regex patterns (`HEX_COLOR_REGEX`) and is the natural home.
- **Impact scope**: `src/lib/validations/common.ts`, `src/lib/admin-token.ts`, `src/lib/key-provider/base-cloud-provider.ts`, `src/lib/env.ts`

### DEV-002: Tests use real verifyAdminToken via env vars (not mocked)
- **Plan description**: Mock `@/lib/admin-token` module for 401 test cases
- **Actual implementation**: Tests manipulate `process.env.ADMIN_API_TOKEN` via `setEnv`/`restoreEnv`, exercising the real `verifyAdminToken` implementation
- **Reason**: Follows the established pattern from `rotate-master-key/route.test.ts`. Tests the full auth path including SHA-256 + timingSafeEqual.
- **Impact scope**: `src/app/api/maintenance/purge-history/route.test.ts`

### DEV-003: Rate limit error uses inline string instead of API_ERROR constant
- **Plan description**: Not explicitly specified (inherited from old implementation using `API_ERROR.RATE_LIMIT_EXCEEDED`)
- **Actual implementation**: Uses inline `"Rate limit exceeded. Try again later."` matching `rotate-master-key` pattern
- **Reason**: Consistency with the reference admin endpoint. Admin endpoints are not consumed by the frontend error display layer that uses `API_ERROR` constants.
- **Impact scope**: `src/app/api/maintenance/purge-history/route.ts`
