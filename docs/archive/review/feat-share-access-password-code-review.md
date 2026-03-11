# Code Review: feat-share-access-password
Date: 2026-03-11T17:05:00+09:00
Review round: 5 (rounds 1-2 from previous session + rounds 3-5 this session)

## Rounds 1-2 — Previous session

### Resolved Findings (Round 1-2)
- [C-1] Critical — proxy.ts blocks unauthenticated access → RESOLVED
- [M-1] Major — logAudit missing tenantId → RESOLVED
- [M-2] Major — File Send requirePassword not extracted from FormData → RESOLVED
- [M-3] Major — Download fallback bypasses password protection → RESOLVED
- [M-4] Major — Missing route tests for verify-access and content → RESOLVED
- [N-1] Major — z.coerce.boolean() coerces "false" to true → RESOLVED
- [m-1] Minor — password max(44) should be max(43) → RESOLVED
- [m-2] Minor — Password gate missing Enter key support → RESOLVED
- [m-3] Minor — sessionStorage comment misleading → RESOLVED
- [m-4] Minor — Access token replay → ACCEPTED (TTL + atomic viewCount)
- [m-5] Minor — userId sentinel → ACCEPTED

## Round 3 — New session, initial review

### Functionality Findings

#### [R3-M-1] Major — `requireSharePassword` policy enforced client-side only
- **Problem:** No server-side enforcement in `POST /api/share-links`. API client can create share without password, bypassing team policy.
- **Status:** RESOLVED — Added `assertPolicySharePassword()` in `team-policy.ts`, enforced in share-links route after `assertPolicyAllowsSharing()`. New `POLICY_SHARE_PASSWORD_REQUIRED` error code with i18n.

#### [R3-M-2] Major — sessionStorage restore not implemented
- **Problem:** Token written to sessionStorage but never read back. Page refresh forces re-verification, consuming viewCount.
- **Status:** RESOLVED — Added `useEffect` in `ShareProtectedContent` to restore token from sessionStorage on mount. Clears stale tokens on failure.

### Security Findings

#### [R3-S-m-1] Minor — Bearer token length validation missing
- **Problem:** No max length on access token before HMAC computation in content and download routes.
- **Status:** RESOLVED — Added `accessToken.length > 512` guard.

#### [R3-S-m-2] Minor — Personal entries not subject to requireSharePassword
- **Status:** ACCEPTED — Design intent: team policy applies to team entries only.

### Testing Findings

#### [R3-T-M-1] Major — sends/share-links missing requirePassword tests
- **Status:** RESOLVED — Added 2 tests to sends/route.test.ts, 3 tests to share-links/route.test.ts.

#### [R3-T-M-2] Major — download route missing password-protected tests
- **Status:** RESOLVED — Added 3 tests (no auth 401, invalid token 401, valid token 200).

#### [R3-T-m-1] Minor — content.test viewCount/accessLog not asserted
- **Status:** RESOLVED

#### [R3-T-m-2] Minor — SharePasswordGate/ShareProtectedContent no component tests
- **Status:** DEFERRED — API layer tested, component tests lower priority.

#### [R3-T-m-3] Minor — TTL boundary test missing
- **Status:** RESOLVED — Added exactly-at-TTL and TTL+1ms test.

## Round 4 — Incremental review

### New Findings

#### [R4-S-M-1] Major — viewCount bypass via direct download
- **Problem:** Password-protected FILE shares: attacker gets access token from verify-access, skips content API, calls download directly. viewCount never incremented → maxViews bypassed.
- **Status:** RESOLVED — Split viewCount responsibility: content API skips increment for FILE type; download route atomically increments for password-protected shares.

#### [R4-F-m-1] Minor — E2E FILE viewCount display off-by-one
- **Problem:** Content API E2E branch returned `viewCount + 1` instead of `viewCount + viewCountDelta`.
- **Status:** RESOLVED

#### [R4-F-m-2] Minor — getTeamPolicy double DB query
- **Status:** ACCEPTED — Performance optimization for future.

## Round 5 — Final security verification

Verified viewCount flow for all 4 combinations:
- Non-protected TEXT/ENTRY_SHARE: page.tsx increments ✓
- Protected TEXT/ENTRY_SHARE: content API increments ✓
- Non-protected FILE: page.tsx increments, download checks only ✓
- Protected FILE: content skips increment, download atomically increments ✓

**No findings.** All agents report clean.

## Final Status

- Tests: 4105 passed (377 files)
- Build: Production build succeeded
- All Critical and Major findings resolved
- Remaining Minor findings accepted/deferred with documented rationale

## Resolution Summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| R3-M-1 | Major | requireSharePassword server-side enforcement | Resolved |
| R3-M-2 | Major | sessionStorage restore | Resolved |
| R4-S-M-1 | Major | viewCount bypass via direct download | Resolved |
| R3-T-M-1 | Major | Missing requirePassword tests | Resolved |
| R3-T-M-2 | Major | Missing download password tests | Resolved |
| R3-S-m-1 | Minor | Bearer length validation | Resolved |
| R3-T-m-1 | Minor | viewCount/accessLog assertion | Resolved |
| R3-T-m-3 | Minor | TTL boundary test | Resolved |
| R4-F-m-1 | Minor | E2E viewCount display | Resolved |
| R3-S-m-2 | Minor | Personal entry policy scope | Accepted |
| R4-F-m-2 | Minor | Double DB query | Accepted |
| R3-T-m-2 | Minor | Component tests | Deferred |
