# Code Review: ea-ui-improvements
Date: 2026-03-15T01:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Critical] useState called after conditional return — Rules of Hooks violation
- **File:** `src/app/[locale]/dashboard/emergency-access/page.tsx`, lines 64–65
- **Problem:** `useState(false)` is called after `if (!session?.user?.id) return null;` (line 50), violating React's Rules of Hooks.
- **Impact:** Runtime error in development ("Rendered more hooks than during the previous render"), unpredictable state corruption in production.
- **Fix:** Move `useState` calls to before the early return, alongside the other state declarations at lines 32–33.

### F2 [Major] No action button for grantee in STALE status
- **File:** `src/components/emergency-access/grant-card.tsx`, lines 411–484
- **Problem:** Hint text `granteeHintStale` instructs the grantee to "re-accept the invitation," but no action button is rendered for `STALE` status on the grantee side.
- **Impact:** Grantee sees instruction but has no button to act on it, leaving them stuck.
- **Fix:** Add grantee action block for `STALE` that renders the same Accept button as `PENDING`.

### F3 [Major] Factory callbacks called inline during render produce new function references every render
- **File:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`, lines 372–374
- **Problem:** `makeGetDetail(entry)`, `makeGetPassword(entry)`, `makeGetUrl(entry)` create new closures on every render.
- **Impact:** Fragile — if PasswordCard ever uses React.memo or adds these to effect deps, it triggers re-decryption. Currently mitigated by internal guards.
- **Fix:** Pre-compute callbacks via `useMemo` outside the render loop.

### F4 [Minor] Silent decryption failures indistinguishable from empty vault (merged with S3)
- **File:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`, lines 192–194
- **Problem:** Entries that fail to decrypt are silently skipped. If all fail, shows "No entries found" with no warning.
- **Fix:** Track failure count and show a warning banner if entries were lost.

## Security Findings

### S1 [Major] waitExpired client-side evaluation underdocumented
- **File:** `src/components/emergency-access/grant-card.tsx`, line 484
- **Problem:** `waitExpired` evaluates client-side clock, showing "Access Vault" button even while status is still `REQUESTED`. Server auto-promotes to `ACTIVATED` when vault is accessed. Design intent is correct but underdocumented.
- **Impact:** Low — server enforces authorization. But could confuse if client clock is ahead.
- **Fix:** Document the server auto-promotion design. Consider showing a "Pending Activation" indicator instead of "Access Vault" when `waitExpired && status !== ACTIVATED`.

### S2 [Minor] ownerEncKeyRef not cleared on unmount
- **File:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`, lines 82–83
- **Fix:** Add cleanup `useEffect` to null out refs on unmount.

### S3 — Merged into F4 (silent decryption failures)

### S4 [Minor] ownerIdRef theoretical race condition
- **File:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`, lines 103, 215
- **Problem:** `decryptBlob` reads `ownerIdRef.current` which could theoretically be overwritten if `decryptEntries` runs twice.
- **Impact:** In practice, runs once. Low risk.
- **Fix:** Capture ownerId in closure rather than reading ref.

## Testing Findings

### T1 [Major] No test for intentional tokenExpiresAt removal on session-auth path
- **File:** `src/app/api/emergency-access/[id]/accept/route.test.ts`
- **Fix:** Add test confirming session-auth accept succeeds even with expired `tokenExpiresAt`.

### T2 [Major] No test for null cross-tenant user lookup in approve/revoke
- **Files:** `src/app/api/emergency-access/[id]/approve/route.test.ts`, `src/app/api/emergency-access/[id]/revoke/route.test.ts`
- **Fix:** Add test where grantee user doesn't exist via `withBypassRls`.

### T3 [Minor] Missing withBypassRls call assertion in vault tests
- **Files:** `src/app/api/emergency-access/[id]/vault/route.test.ts`, `[id]/vault/entries/route.test.ts`
- **Fix:** Add `expect(mockWithBypassRls).toHaveBeenCalled()` in success paths.

### T4 [Minor] No call-count split assertion in root route test
- **File:** `src/app/api/emergency-access/route.test.ts`
- **Fix:** Assert `withBypassRls` called once and `withUserTenantRls` called for owner-side ops.

## Resolution Status

### F1 [Critical] useState after conditional return
- **Action:** Moved `useState` calls to before the early return (lines 32–35)
- **Modified file:** `src/app/[locale]/dashboard/emergency-access/page.tsx`

### F2 [Major] STALE action button / hint text
- **Action:** Investigated state machine — STALE→ACCEPTED is not a valid transition; the owner's `EmergencyAccessProvider` confirms STALE→IDLE automatically. Fixed grantee hint text to explain this instead of incorrectly instructing re-acceptance.
- **Modified files:** `messages/en/EmergencyAccess.json`, `messages/ja/EmergencyAccess.json`

### F3 [Major] Unstable callback references
- **Action:** Pre-computed callbacks via `useMemo` in `entryCallbacks` array; render loop now looks up stable references by entry ID.
- **Modified file:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`

### F4/S3 [Minor] Silent decryption failures
- **Action:** Added `decryptFailCount` state, `failCount` tracking in decrypt loop, and yellow warning banner with new i18n key `decryptFailWarning`.
- **Modified files:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`, `messages/en/EmergencyAccess.json`, `messages/ja/EmergencyAccess.json`

### S1 [Major] waitExpired underdocumented
- **Action:** Added design comment explaining client-side convenience vs server-side authorization.
- **Modified file:** `src/components/emergency-access/grant-card.tsx`

### S2 [Minor] ownerEncKeyRef not cleared on unmount
- **Action:** Added cleanup `useEffect` to null out `ownerEncKeyRef` and `ownerIdRef` on unmount.
- **Modified file:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`

### S4 [Minor] ownerIdRef theoretical race condition
- **Action:** Skipped — `decryptEntries` runs once on vault unlock; theoretical risk only. Complexity of fix not justified.

### T1 [Major] tokenExpiresAt test
- **Action:** Added test `succeeds even if tokenExpiresAt is in the past`.
- **Modified file:** `src/app/api/emergency-access/[id]/accept/route.test.ts`

### T2 [Major] Null user lookup tests
- **Action:** Added tests for approve and revoke routes where grantee user returns null.
- **Modified files:** `src/app/api/emergency-access/[id]/approve/route.test.ts`, `src/app/api/emergency-access/[id]/revoke/route.test.ts`

### T3 [Minor] withBypassRls assertions
- **Action:** Added `expect(mockWithBypassRls).toHaveBeenCalled()` to vault and entries success tests.
- **Modified files:** `src/app/api/emergency-access/[id]/vault/route.test.ts`, `src/app/api/emergency-access/[id]/vault/entries/route.test.ts`

### T4 [Minor] Call-count split assertion
- **Action:** Added `mockWithBypassRls` and `mockWithUserTenantRls` call assertions to root route create test.
- **Modified file:** `src/app/api/emergency-access/route.test.ts`

### N1 [Minor] `noop` recreated every render
- **Action:** Moved `noop` to module-level constant outside the component.
- **Modified file:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`

### N2 [Minor] `entryCallbacks.find()` is O(n) per entry (O(n²) total)
- **Action:** Replaced array + `find()` with a `Map` keyed by entry ID for O(1) lookup.
- **Modified file:** `src/app/[locale]/dashboard/emergency-access/[id]/vault/page.tsx`

### N3 [Minor] Dynamic `hintKey` bypasses next-intl type checking
- **Action:** Skipped — cosmetic issue, no runtime impact. next-intl supports dynamic keys at runtime.

### N4 [Minor] `ownerHintRejected` text ambiguity
- **Action:** Skipped — existing wording is consistent with the owner's perspective; changing it is a UX copy decision outside review scope.
