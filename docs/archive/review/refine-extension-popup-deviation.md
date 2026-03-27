# Coding Deviation Log: refine-extension-popup
Created: 2026-03-28

## Deviations from Plan

### D-1: updateBadgeForTab uses cachedEntries directly instead of getCachedEntries()
- **Plan description**: Use `getCachedEntries()` + `isHostMatch()` to count entries
- **Actual implementation**: Uses `cachedEntries` variable directly (cache-only, no fetch)
- **Reason**: Calling `getCachedEntries()` triggers network fetches which interfered with test mocks and could cause unwanted side effects from badge update operations
- **Impact scope**: Badge may show 0 until cache is populated by another operation (FETCH_PASSWORDS, GET_MATCHES_FOR_URL)

### D-2: Task 4 (isHostMatch) — no code change
- **Plan description**: Review isHostMatch() for security implications
- **Actual implementation**: Analyzed and documented as accepted design decision (same as 1Password/Bitwarden)
- **Reason**: Tightening subdomain matching would break legitimate use cases (login.example.com matching example.com entries)
- **Impact scope**: None — existing behavior preserved
