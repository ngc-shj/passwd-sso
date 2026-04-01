# Plan: fix-keyboard-shortcuts-overlay

## Objective

Fix the bug where keyboard shortcuts (e.g., "N" to create a new entry) are active while the `AutoExtensionConnect` full-screen overlay is displayed. Users connecting via the browser extension flow see the overlay, but pressing "N" opens the entry creation dialog behind it.

## Requirements

### Functional Requirements

- F1: When `AutoExtensionConnect` overlay is visible (status !== IDLE), keyboard shortcuts from `PasswordDashboard` must not fire
- F2: The auto-lock activity listener (`auto-lock-context.tsx`) should still function during the overlay (it tracks user presence, not UI actions)
- F3: When the overlay is dismissed (user clicks "Go to dashboard"), keyboard shortcuts must resume normally

### Non-Functional Requirements

- NF1: The fix must not introduce coupling between `AutoExtensionConnect` and `PasswordDashboard` — they are independent components
- NF2: The fix must work for any future overlay that uses the same pattern (full-screen `fixed inset-0 z-50`)

## Technical Approach

### Root Cause

`PasswordDashboard` registers keyboard shortcuts via `window.addEventListener("keydown", handler)` at `src/components/passwords/password-dashboard.tsx:215`. `AutoExtensionConnect` renders as a sibling under `VaultGate` (`src/components/vault/vault-gate.tsx:54-58`):

```tsx
<>
  <AutoExtensionConnect />
  {children}  {/* includes PasswordDashboard */}
</>
```

When the overlay is active (status !== IDLE), both components are mounted. The overlay uses `fixed inset-0 z-50` to cover the screen visually, but does not prevent keyboard events from reaching the underlying dashboard's `window.keydown` listener.

### Fix Strategy

Add an `onKeyDown` handler on the overlay's root `<div>` that calls `e.stopPropagation()`. This prevents keyboard events from bubbling up to `window`-level listeners while the overlay is active.

**However**, `window.addEventListener("keydown")` uses the capture/bubble model at the `window` level. `e.stopPropagation()` on a child div would prevent bubbling to `window` only if the `window` listener uses bubble phase (which it does — no `{ capture: true }`). But because `window` is the top of the DOM tree, events added to `window` actually fire for ALL keydown events regardless of where they originate.

The correct fix is: **`PasswordDashboard` should check whether a modal overlay is active before handling shortcuts.** The simplest, least-coupled approach:

**Check if the keyboard event target or its ancestors include a `[data-overlay-active]` element.** This is a DOM-based approach that requires no shared state:

1. Add `data-overlay-active` attribute to the `AutoExtensionConnect` overlay root div
2. In `PasswordDashboard`'s keydown handler, check if any element with `[data-overlay-active]` exists in the DOM and skip processing if so

Alternative considered: Using a React context to signal overlay state. Rejected because it would require threading a provider through `VaultGate`, adding coupling between unrelated components.

Alternative considered: `e.stopPropagation()` on the overlay. Rejected because `window.addEventListener` captures events at the window level before they propagate to DOM elements, so stopping propagation on a DOM element cannot prevent window-level listeners from firing.

### Scope

Three components use `window.addEventListener("keydown")`:

1. `PasswordDashboard` (`password-dashboard.tsx:215`) — N, /, ?, Escape, Ctrl+K — **must be guarded**
2. `TeamVaultPage` (`teams/[teamId]/page.tsx:565`) — Escape only, in selection mode — **not affected** because the team page is a separate route from the personal dashboard; `AutoExtensionConnect` only renders under the personal dashboard's `VaultGate`. When on a team page, the extension connect overlay is not visible.
3. `AutoLockProvider` (`auto-lock-context.tsx:81`) — any key for activity tracking — **must NOT be guarded** (needs to detect user activity even during overlay)

## Implementation Steps

1. **Add `data-overlay-active` attribute**: In `src/components/extension/auto-extension-connect.tsx`, add `data-overlay-active` to the overlay root div (the `fixed inset-0 z-50` element, rendered when status !== IDLE).
2. **Extract overlay check utility**: Create a pure function `isOverlayActive(): boolean` that returns `!!document.querySelector("[data-overlay-active]")`. Place it in `src/components/extension/auto-extension-connect.tsx` (co-located with the attribute producer) and export it.
3. **Guard keyboard shortcuts**: In `src/components/passwords/password-dashboard.tsx`, import `isOverlayActive` and add an early return at the **very first line** of the keydown handler (before the `Ctrl+K` check at line 168). This ensures ALL shortcuts — including `Ctrl+K` and `Escape` — are suppressed while the overlay is active.
4. **Add test — overlay attribute**: In `src/components/extension/auto-extension-connect.test.tsx`, add a test verifying `document.querySelector("[data-overlay-active]")` is non-null when status is CONNECTED, and null when no ext_connect param (IDLE renders nothing).
5. **Add test — isOverlayActive**: Unit test the `isOverlayActive` function directly: returns `true` when a `div[data-overlay-active]` is in the DOM, `false` when absent. This is a pure function test independent of the full component.
6. **Add test — keyboard guard**: Test that dispatching `keydown` "n" to `window` while `[data-overlay-active]` is in the DOM does not trigger the shortcut. After removing the attribute, dispatching "n" should trigger it. This tests F1 and F3 (resume after dismiss).

## Testing Strategy

- **Unit test — overlay attribute**: `auto-extension-connect.test.tsx` — verify `document.querySelector("[data-overlay-active]")` returns non-null when CONNECTED; returns null when IDLE (component renders nothing)
- **Unit test — isOverlayActive**: Test the exported pure function directly — insert/remove a `div[data-overlay-active]` in jsdom, assert return value
- **Unit test — keyboard guard**: Test that `window` keydown "n" is ignored when `[data-overlay-active]` exists in DOM, and fires when absent. This tests both F1 (suppression) and F3 (resume after dismiss). Test structure: use a minimal mock of the keyboard handler logic or test `isOverlayActive` integration
- **Manual verification**: Open app with `?ext_connect=1`, verify "N" key does not open entry creation dialog. Click "Go to dashboard", verify "N" key works again
- **Build verification**: `npx vitest run` + `npx next build`

## Considerations & Constraints

- **No shared state needed**: The DOM attribute approach is decoupled — any overlay can opt in by adding `data-overlay-active`, and any keyboard handler can opt in by checking for it
- **Performance**: `document.querySelector` on keydown is negligible — it's a single attribute selector on the DOM
- **Future overlays**: Any component that renders a full-screen overlay can add `data-overlay-active` to suppress keyboard shortcuts
- **Auto-lock unaffected**: `auto-lock-context.tsx` tracks activity (any key press) and should NOT be guarded — it needs to know the user is active even during overlays

## User Operation Scenarios

### Scenario 1: Extension connect flow
1. User opens passwd-sso from browser extension (URL includes `?ext_connect=1`)
2. Vault unlock screen appears, user enters passphrase
3. After unlock, `AutoExtensionConnect` overlay appears with "Connecting..." spinner
4. User presses "N" — **nothing happens** (previously opened entry creation dialog)
5. Connection succeeds, overlay shows "Connected" with "Go to dashboard" button
6. User presses "N" — **nothing happens** (overlay still active)
7. User clicks "Go to dashboard"
8. Overlay disappears, dashboard loads
9. User presses "N" — **entry creation dialog opens** (shortcuts resume)

### Scenario 2: Extension connect failure
1. Same as above, but connection fails
2. Overlay shows "Failed" with "Retry" and "Go to dashboard" buttons
3. User presses "N" — **nothing happens**
4. User clicks "Go to dashboard" to dismiss
5. Dashboard loads, "N" key works normally

## Files to Update

- `src/components/extension/auto-extension-connect.tsx` — add `data-overlay-active` attribute + export `isOverlayActive()` function
- `src/components/passwords/password-dashboard.tsx` — import `isOverlayActive`, add guard at handler top
- `src/components/extension/auto-extension-connect.test.tsx` — add data attribute test + isOverlayActive unit test + keyboard guard test
