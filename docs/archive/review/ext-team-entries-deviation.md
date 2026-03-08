# Coding Deviation Log: ext-team-entries
Created: 2026-03-08

## Deviations from Plan

### DEV-1: No new i18n strings for team badge
- **Plan description**: Step 17 — Add i18n strings for team badge label
- **Actual implementation**: Team badge renders `teamName` directly (no translated label needed)
- **Reason**: The badge shows the actual team name, not a generic "Team" label. This is more informative and follows the existing pattern of `badgeCard` / `badgeIdentity` where a label is used because the type is fixed, whereas team names are dynamic.
- **Impact scope**: No impact — no strings needed

### DEV-2: getCachedEntries also fetches team entries
- **Plan description**: Plan Step 14 mentions updating GET_MATCHES_FOR_URL to include team entries
- **Actual implementation**: Updated `getCachedEntries()` (used by both FETCH_PASSWORDS and GET_MATCHES_FOR_URL) to merge personal + team entries via `Promise.allSettled`
- **Reason**: `getCachedEntries` feeds both the popup list and URL matching. Updating it once covers both use cases without duplication.
- **Impact scope**: GET_MATCHES_FOR_URL now automatically includes team entries

### DEV-3: FETCH_PASSWORDS failsafe behavior change
- **Plan description**: Not explicitly addressed in plan
- **Actual implementation**: `Promise.allSettled` catches personal fetch errors gracefully, returning empty entries instead of propagating to the outer catch (which returns `entries: null, error: ...`)
- **Reason**: Partial failure (personal fails, team succeeds, or vice versa) should still return available entries. This is more resilient.
- **Impact scope**: Updated existing test expectation in `background.test.ts`

### DEV-4: Team key fetch includes member-key API call before cache check
- **Plan description**: Plan suggests cache-first with TTL check
- **Actual implementation**: `getTeamEncryptionKey()` fetches the member-key first to determine the actual `keyVersion`, then checks cache with the resolved version
- **Reason**: Without knowing the actual keyVersion upfront, we can't form the correct cache key. The member-key fetch is lightweight and needed for the ECDH unwrap params.
- **Impact scope**: One extra HTTP call per team key resolution (mitigated by cache)

### DEV-5: No separate teams:read extension token scope
- **Plan description**: Plan mentioned adding teams:read scope to EXTENSION_TOKEN_SCOPE
- **Actual implementation**: Reuses `passwords:read` scope for team API access
- **Reason**: Team password endpoints serve the same purpose as personal ones. Adding a separate scope would require DB migration and extension re-authorization without meaningful security benefit. Users who grant password access expect to see all their passwords.
- **Impact scope**: No new scope constant or migration needed
