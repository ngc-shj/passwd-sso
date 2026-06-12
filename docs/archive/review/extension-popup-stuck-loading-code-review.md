# Code Review: extension-popup-stuck-loading

Date: 2026-06-12
Review rounds: 2 (terminated — all lenses "No findings" in Round 2)
Branch: fix/extension-popup-stuck-loading

## Summary

Fix for the browser-extension popup occasionally getting stuck on the
"読み込み中 / Loading" spinner with no lock/sign-out buttons.

Root cause: `refreshStatus()` issued `sendMessage({ type: "GET_STATUS" })` with no
`.catch()`. Under MV3, the service worker can be torn down (or hang while awaiting
`hydrationPromise`), so `chrome.runtime.sendMessage` rejects ("message channel
closed"). With no rejection handler, `setState` was never called and `state`
stayed at its initial `"loading"`. The header lock/disconnect buttons render only
in `logged_in`/`vault_unlocked`, so they were absent too.

Fix: wrap GET_STATUS in a 3s timeout (`fetchStatus`), add `.catch()` with up to 2
retries (250ms apart), and on persistent failure show a new `"error"` state with a
Retry button — eliminating the permanent-spinner failure mode.

## Changed files
- `extension/src/popup/App.tsx`
- `extension/src/messages/en.json`, `ja.json` (`popup.statusError`, `popup.retry`)
- `extension/src/__tests__/popup/App.test.tsx` (4 new tests)

## Round 1 Findings & Resolution

Security expert: No findings (fail-closed confirmed; GET_STATUS idempotent;
no information disclosure; R37 clean).

### F2 [Major] Background refresh failure clobbers a working screen — RESOLVED
- The `chrome.storage.onChanged` listener called bare `refreshStatus()`, so a
  transient failure during a vault-lock event could flip a good `vault_unlocked`
  view to the full-screen error pane.
- Fix: added `allowError` param; the storage listener now calls
  `refreshStatus(0, false)`. Only initial load and manual Retry surface `error`.
- File: `extension/src/popup/App.tsx:52,92`

### T2 [Major] Automatic-retry recovery path untested — RESOLVED
- Added test "recovers automatically when an internal retry succeeds (no user
  action)": first attempt rejects, scheduled retry resolves → MatchList renders,
  no Retry button ever shown.
- File: `extension/src/__tests__/popup/App.test.tsx:155`

### F3 [Minor] Floating rejection after timeout wins the race — RESOLVED
- Attached `status.catch(() => {})` to the underlying sendMessage promise so a
  late rejection does not become an unhandledrejection. `Promise.race` still
  observes the original rejection and retries fire (verified).
- File: `extension/src/popup/App.tsx:20-23`

### F5 [Minor] Unguarded handleLock/handleDisconnect (pre-existing, in scope) — RESOLVED
- `handleLock`: try/catch, still sets `logged_in` (fail-secure — a torn-down SW
  has already lost its in-memory key).
- `handleDisconnect`: try/catch; on failure sets `error` and returns rather than
  falsely claiming `not_logged_in` (CLEAR_TOKEN revokes server-side and may not
  have run).
- File: `extension/src/popup/App.tsx:99-120`

### T3 [Minor] Timeout-hang path untested — RESOLVED
- Added fake-timer test "shows the retry control when the status request hangs
  past the timeout" (sendMessage never settles; advance 10s through all 3
  timeouts + 2 retry delays).
- File: `extension/src/__tests__/popup/App.test.tsx:177`

### Accepted / informational (no action)
- F1 (error state hides lock/disconnect): acceptable — a wedged SW also blocks
  those messages, so Retry is the only meaningful action. Strict improvement over
  the infinite spinner.
- F4 (Retry interleaving with in-flight chain): low likelihood, benign outcome;
  largely neutralized by the F2 fix. States are idempotent.
- F6/F7 (retry effectiveness vs wedged hydration; worst-case ~9.5s to error):
  informational. Follow-up candidate: add a timeout to `hydrateFromSession()` in
  the service worker so GET_STATUS returns a degraded status instead of hanging.
- T1/T4/T5/T6 (mock omits optional `tenantAutoLockMinutes`; timer leak; mockReset;
  isolation): no-action — harmless / sound in current ordering.

## Round 2 (incremental verification)

Combined functionality / security (token-lifecycle) / testing review of the fix
diff. **No findings** in any lens:
- allowError threading verified (preserved through retries; background failure
  leaves prior state untouched; initial load always reaches a terminal state).
- handleDisconnect→error justified (fail-closed, two-step Retry recovery, no
  lockout). handleLock fail-secure claim verified against the synchronous
  LOCK_VAULT SW handler.
- F3 catch does not consume the race's rejection (verified empirically).
- Both new tests assert the intended paths; fake-timer test is deterministic.
- R37 pass; R25 N/A; RS1-RS4 N/A; no stale closures.

## Verification
- `npx tsc --noEmit` — clean
- `npx vitest run` (extension) — 748 passed / 50 files
- `npm run build` (extension) — success

## Follow-up (out of scope, not blocking)
- Service-worker `hydrateFromSession()` lacks a timeout; a hung internal await
  there keeps GET_STATUS blocked across retries. Tracked for a separate change.
