# Code Review: fix-share-dialog-field-preview

Date: 2026-03-09
Review rounds: 4

## Round 1: share-dialog.tsx fix

### Round 1 Changes

Filter out `undefined`/`null` fields from share dialog preview and create payload.

### Round 1 Functionality

No findings.

### Round 1 Security

No findings.

### Round 1 Testing

No findings. (Pre-existing gap: no test file for share-dialog.tsx)

## Round 2: getScimBaseUrl + AUTH_URL + reverse proxy docs

### Round 2 Changes

- `getScimBaseUrl` reads `NEXT_PUBLIC_BASE_PATH` instead of relying on AUTH_URL path
- Leading slash normalization for `NEXT_PUBLIC_BASE_PATH`
- Docs: AUTH_URL origin-only, Apache/nginx reverse proxy examples

### Round 2 Functionality

No findings.

### Round 2 Security

No findings (Critical/Major).

Minor (dismissed):

1. Path injection via NEXT_PUBLIC_BASE_PATH — env var, not user input. Low risk.
2. NEXT_PUBLIC_ prefix exposure — intentional, required for client routing.

### Round 2 Testing

No findings. 8 test cases cover all branches including leading slash normalization.

## Round 3: Final review after all fixes

### Round 3 Changes

No new changes — final confirmation round after Round 2 fixes.

### Round 3 Functionality

No findings.

### Round 3 Security

No findings.

### Round 3 Testing

No findings.

## Round 4: getAppOrigin() helper consolidation

### Round 4 Changes

- Extracted `getAppOrigin()` helper in `url-helpers.ts` (single source of truth for `APP_URL || AUTH_URL`)
- Replaced inline fallback chains in `cors.ts`, `csrf.ts`, `admin-reset/route.ts`, `scim/response.ts`
- Added `APP_URL` validation to `env.ts`
- Removed `NEXTAUTH_URL` and `localhost` fallbacks from `getScimBaseUrl()`
- Updated `.env.example`: added `APP_URL`, fixed `AUTH_URL` comment

### Round 4 Functionality

1. **Major** (resolved): `getScimBaseUrl()` returned relative path `/api/scim/v2` when no origin env set. RFC 7644 requires absolute URLs. Fixed: throws Error when `getAppOrigin()` is undefined. AUTH_URL is required in production (env.ts), so only affects misconfigured dev.

2. **Minor** (resolved): `admin-reset/route.ts` guard `if (!appUrl)` appeared redundant with `assertOrigin()`. Intentional: `assertOrigin` skips when unset (dev convenience), admin-reset requires it (500). Added clarifying comment.

### Round 4 Security

No findings (Critical/Major).

Minor (dismissed):

1. `APP_URL` allows `http://` in production — same as existing `AUTH_URL` pattern. Out of scope for this PR.

### Round 4 Testing

1. **Minor** (resolved): Added empty-string test for `getAppOrigin`.
2. **Minor** (resolved): Added `APP_URL` + basePath combination test for `getScimBaseUrl`.
3. Added `AUTH_URL` to 4 SCIM route test files to satisfy new `getScimBaseUrl` guard.

## Resolution Status

All findings from Round 4 resolved. Tests: 3860 passed. Build: success.
Local LLM pre-screening found 1 valid issue (missing leading slash) in Round 2.
Round 4 found 1 Major (SCIM relative URL) — fixed with throw guard.
