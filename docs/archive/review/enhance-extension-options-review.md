# Plan Review: enhance-extension-options
Date: 2026-04-03T00:00:00+09:00
Review rounds: 4 (converged at round 4 — all Major/Critical resolved)

## Changes from Previous Round
Initial review

## Functionality Findings

**[F-01] Major: `enableContextMenu` toggle architecture mismatch**
- Problem: Plan references `buildContextMenu()` which doesn't exist. Actual functions are `setupContextMenu()` (static parent) and `updateContextMenuForTab()` / `doUpdateMenu()` (dynamic children). Toggle behavior and real-time propagation via `chrome.storage.onChanged` not defined.
- Impact: Implementer won't know which functions to modify; context menu may remain visible after disabling.
- Recommended action: Specify that `enableContextMenu = false` → skip `setupContextMenu()` / `chrome.contextMenus.removeAll()`, and add `chrome.storage.onChanged` listener for real-time toggle.

**[F-02] Major: `autoCopyTotp` is a NEW feature, not existing toggle**
- Problem: Plan assumes "Auto-copy TOTP after autofill: always on" — this is incorrect. Current `performAutofillForEntry()` does NOT copy TOTP to clipboard; `COPY_TOTP` is a separate message handler. This is new functionality, not exposing an existing hardcoded behavior.
- Impact: Scope and effort estimate is wrong. Need to implement TOTP clipboard copy logic in the autofill path.
- Recommended action: Reclassify F5 as a new feature. Add implementation details: detect TOTP config after autofill → `copyToClipboard()` + `lastClipboardCopyTime` update + alarm scheduling.

**[F-03] Major: `clipboardClearSeconds` real-time propagation not designed**
- Problem: `CLIPBOARD_CLEAR_DELAY_MS` is a module-scope constant. Plan doesn't specify how the dynamic value is read (at copy time vs onChanged listener). Current `onChanged` handler only reacts to `serverUrl` and `autoLockMinutes`.
- Impact: First copy after settings change may use stale value. Already-scheduled setTimeout uses old delay.
- Recommended action: Read `clipboardClearSeconds` via `getSettings()` at each copy operation. Document this approach in plan.

**[F-04] Major: `showSavePrompt`/`showUpdatePrompt` pending prompt delivery**
- Problem: Disabling save/update prompts won't affect already-queued `pendingSavePrompts` (TTL up to 30s). User toggles off but still sees prompts from the queue.
- Impact: User expectation mismatch — prompt appears after disabling.
- Recommended action: Check `showSavePrompt`/`showUpdatePrompt` at delivery time (`tabs.onUpdated` handler, line ~556) in addition to detection time.

**[F-05] Major: `vaultTimeoutAction: "logout"` implementation details undefined**
- Problem: Plan says "clear token+session" but doesn't specify whether to call `revokeCurrentTokenOnServer()`, how `clearToken()` vs `clearVault()` differ, or tenant policy priority for this setting.
- Impact: Incomplete logout may leave server-side token valid. Tenant override behavior unclear.
- Recommended action: Define logout path: `revokeCurrentTokenOnServer()` → `clearToken()` → `clearVault()`. Document tenant policy priority.

**[F-06] Minor: `showBadgeCount = false` badge behavior ambiguous**
- Problem: Badge has per-tab count AND global status (`×`/`!`). Plan doesn't specify which to suppress.
- Impact: Implementer may suppress all badges or only count, diverging from user intent.
- Recommended action: Clarify: `showBadgeCount = false` → suppress per-tab count only; keep `×`/`!` status indicators.

**[F-07] Minor: `DEFAULTS` constant update not explicitly stated**
- Problem: Implementation step 1 doesn't mention updating `DEFAULTS` in storage.ts alongside `StorageSchema`.
- Impact: Existing users get `undefined` for new fields.
- Recommended action: Explicitly include "update `DEFAULTS` with all new field defaults" in step 1.

## Security Findings

**[SEC-01] Major: `clipboardClearSeconds` lacks defense-in-depth validation**
- Problem: StorageSchema defines `clipboardClearSeconds` as `number`. UI uses dropdown but `chrome.storage.local` can be written directly. Zero or huge values would disable clipboard clearing.
- Impact: Password persists in clipboard indefinitely if tampered.
- Recommended action: Background validates against whitelist `[10, 20, 30, 60, 120, 300]` before use; fallback to 30s for invalid values.

**[SEC-02] Major: `vaultTimeoutAction: "logout"` missing server-side token revocation**
- (Merged with F-05 — same root cause, security perspective adds token revocation requirement)
- Problem: Current `clearToken()` doesn't call `revokeCurrentTokenOnServer()`. Alarm handler for logout path must explicitly revoke.
- Impact: Stolen token remains valid on server after local logout.
- Recommended action: Logout path must await `revokeCurrentTokenOnServer()` before `clearToken()`.

**[SEC-03] Minor: In-flight clipboard timer not updated on settings change**
- (Related to F-03 — security perspective on stale timer)
- Problem: Already-running setTimeout uses old delay value after settings change.
- Impact: Password clipboard retention exceeds user's configured time (minor window).
- Recommended action: On `chrome.storage.onChanged` for `clipboardClearSeconds`, reschedule active timer if `lastClipboardCopyTime` is recent.

**[SEC-04] Minor: Theme value injection via `className` assignment**
- Problem: If `theme` value in storage is tampered to arbitrary string, naive `className = value` could inject content.
- Impact: Low risk in extension context (CSP protects), but defense-in-depth missing.
- Recommended action: Whitelist validate `["light", "dark", "system"]` in `applyTheme()`. Use `classList.add/remove` instead of direct `className` assignment.

## Testing Findings

**[QA-01] Major: `storage.test.ts` breaks when StorageSchema is extended**
- Problem: Existing test uses `toEqual` with 2-field object. Adding 9 fields breaks the assertion.
- Impact: CI fails at step 1 before tests are updated at step 8.
- Recommended action: Update storage tests in the same commit as StorageSchema extension (merge steps 1 and 8 for storage).

**[QA-02] Major: `background.test.ts` mock doesn't return new settings fields**
- Problem: `installChromeMock()` returns only `{ serverUrl, autoLockMinutes }`. New setting-dependent branches (badge toggle, context menu toggle, logout action) won't be tested.
- Impact: Setting-conditional logic has no test coverage.
- Recommended action: Update mock to return all default fields. Add test cases for each boolean toggle (enabled/disabled) and `vaultTimeoutAction` variants.

**[QA-03] Major: `theme.ts` test needs jsdom environment and matchMedia mock**
- Problem: `vitest.config.ts` uses `node` environment. `applyTheme()` manipulates `document.documentElement.classList` and reads `window.matchMedia`. Neither available in node.
- Impact: Theme tests fail or get skipped.
- Recommended action: Add `@vitest-environment jsdom` to theme test file. Mock `window.matchMedia` with `vi.fn()`. Test 4 cases: light, dark, system+dark, system+light.

**[QA-04] Major: `chrome.commands.getAll()` not in existing Chrome API mocks**
- Problem: Options test stubs only `chrome.permissions` and `chrome.runtime`. F12 keyboard shortcuts display calls `chrome.commands.getAll()` which will throw.
- Impact: Options page render tests fail.
- Recommended action: Add `commands: { getAll: vi.fn().mockResolvedValue([...]) }` to options test mock setup.

**[QA-05] Minor: Options App test `mockGetSettings` needs new fields**
- Problem: Test returns only `{ serverUrl, autoLockMinutes }`. Save button test won't verify new fields are included in `setSettings` call.
- Impact: Missing field in save logic goes undetected.
- Recommended action: Update mock to return full StorageSchema. Add test: Save → verify `setSettings` called with all fields.

## Adjacent Findings

**[SEC-05] [Adjacent] Minor: No tenant policy mechanism for `clipboardClearSeconds`**
- Problem: `autoLockMinutes` has tenant policy override but `clipboardClearSeconds` doesn't. Enterprise admins can't enforce clipboard clear policy.
- Impact: Security policy gap for enterprise deployments.
- Recommended action: Document as out-of-scope for this PR. Consider `clipboardClearMaxSeconds` tenant policy in a future enhancement.

## Quality Warnings
None
