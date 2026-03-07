# Code Review: import-fetch-and-lock-session-expiry
Date: 2026-03-07
Review round: 2

## Changes from Previous Round

- Session expiry detection changed from `useSession()` (Auth.js) to vault API 401 detection
- `vault-context.tsx`: `unlock()`, `unlockWithPasskey()`, `unlockWithStoredPrf()` now throw `VaultUnlockError(API_ERROR.UNAUTHORIZED)` on 401
- `vault-lock-screen.tsx`: Removed `useSession` dependency, added local `sessionExpired` state set in catch blocks
- Removed WebAuthn credentials fetch `sessionExpired` guard (no longer known at mount time)

## Functionality Findings

No findings.

Round 1 findings status:
- F1 [Minor] WebAuthn fetch guard — Design changed. Guard removed because `sessionExpired` is only known after unlock attempt. Mount-time 401 from credentials fetch is harmless (caught by `res.ok` check).
- F2 [Minor] Checkboxes not disabled at limit — Resolved (persists from Round 1)
- F3 [Minor] ESLint rule coverage — Accepted (no action)

## Security Findings

No findings.

Verified:
- 401 detection cannot be exploited (server-side session validation, HTTPS in production)
- Session expired UI reveals no personal information
- Key material never reached on 401 (early throw)
- PRF sessionStorage data cleared before 401 check in `unlockWithStoredPrf`

## Testing Findings

No findings.

Round 1 findings status:
- T1 [Major] password-import-tags tests — False positive (tests exist)
- T2 [Major] vault-lock-screen render tests — Deferred (high mock complexity, low risk)
- T3 [Minor] onSelectedCountChange atLimit=true — Resolved
- T4 [Minor] toggleSelectOneId re-add at limit — Resolved
- T5 [Minor] allSelected semantics comment — Resolved

## Resolution Status

### F1 [Minor] WebAuthn fetch on expired session — Design changed (accepted)

- Action: Guard removed; mount-time 401 is harmless (one extra request, no functional impact)
- Rationale: `sessionExpired` is no longer known at mount time (only set after unlock attempt)

### F2 [Minor] Checkboxes not disabled at selection limit — Resolved

- Action: Added `disabled={atLimit && !selectedIds.has(entry.id)}` to all bulk Checkboxes
- Modified files: `password-list.tsx`, `trash-list.tsx`, `team-trash-list.tsx`, `team-archived-list.tsx`, `teams/[teamId]/page.tsx`

### F3 [Minor] ESLint rule coverage — Accepted (no action)

- Rationale: No existing code uses bypass patterns. Monitor for future emergence.

### T1 [Major] No tests for password-import-tags.ts — False positive

- Tests already exist in `src/components/passwords/password-import-tags.test.ts` (via re-export from `password-import-utils.ts`)

### T2 [Major] No render tests for vault-lock-screen session expiry — Acknowledged (deferred)

- Rationale: Component has extensive dependencies (useVault, useTranslations, fetchApi, WebAuthn). The session detection logic is a simple catch-and-set-state pattern. Full component render test deferred due to high mock complexity vs low risk.

### T3 [Minor] onSelectedCountChange atLimit=true — Resolved

- Action: Added test "notifies onSelectedCountChange with atLimit=true"
- Modified file: `src/hooks/use-bulk-selection.test.ts`

### T4 [Minor] toggleSelectOneId re-add at limit — Resolved

- Action: Added test "allows re-adding existing id when at max"
- Modified file: `src/lib/bulk-selection-helpers.test.ts`

### T5 [Minor] allSelected semantics comment — Resolved

- Action: Added comment `// allSelected means "all selectable items selected" (capped by maxSelection)`
- Modified file: `src/hooks/use-bulk-selection.test.ts`
