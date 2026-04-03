# Plan: fix-origin-check-unused-import

## Objective

Fix two GitHub Code Scanning (CodeQL) alerts on the `main` branch:

- **#112** (warning): `js/missing-origin-check` in `src/lib/inject-extension-token.test.ts:9`
- **#113** (note): `js/unused-local-variable` in `extension/src/__tests__/background.test.ts:7`

## Requirements

### Functional
- Alert #112: Add origin verification to the `postMessage` listener in the test so CodeQL no longer flags it
- Alert #113: Remove the unused `SESSION_KEY` import from the test file
- All existing tests must continue to pass
- Production build must succeed

### Non-functional
- Do not change production code — both alerts are in test files
- Changes must be minimal and targeted

## Technical Approach

### Alert #112: Missing origin check (`js/missing-origin-check`)

**File:** `src/lib/inject-extension-token.test.ts:9`

**Problem:** The test's `window.addEventListener("message", ...)` handler does not check `event.origin`. CodeQL flags this as `js/missing-origin-check` because a `postMessage` handler without origin verification could process messages from untrusted origins.

**Production context:** The production code `injectExtensionToken()` correctly passes `window.location.origin` as the `targetOrigin` argument to `postMessage`. The test handler should mirror this by checking `event.origin`.

**Fix:** Add an origin check inside the listener callback. In jsdom, `event.origin` is `""` (empty string) because jsdom does not fully implement the `postMessage` origin mechanism. So the test should check for either `window.location.origin` or `""` (jsdom fallback).

```typescript
window.addEventListener("message", (e) => {
  // jsdom sets event.origin to "" instead of window.location.origin
  if (e.origin !== window.location.origin && e.origin !== "") return;
  resolve(e);
}, { once: true });
```

### Alert #113: Unused import (`js/unused-local-variable`)

**File:** `extension/src/__tests__/background.test.ts:7`

**Problem:** `SESSION_KEY` is imported but never used in the test file.

**Fix:** Remove `SESSION_KEY` from the import statement.

## Implementation Steps

1. Edit `src/lib/inject-extension-token.test.ts`: Add origin check to the `message` event listener
2. Edit `extension/src/__tests__/background.test.ts`: Confirm `SESSION_KEY` has no other usage in the file, then remove it from the import statement
3. Run `npx vitest run` to verify tests pass
4. Run `npx next build` to verify production build succeeds

## Testing Strategy

- Existing unit tests must pass unchanged (the origin check in #112 must not break the test assertion)
- No new tests needed — these are fixes to existing test files
- Verify via `npx vitest run` and `npx next build`

## Considerations & Constraints

- **jsdom limitation:** `postMessage` in jsdom sets `event.origin` to `""` rather than `window.location.origin`. The origin check must account for this to avoid breaking the test.
- **CodeQL detection:** The fix must satisfy CodeQL's `js/missing-origin-check` rule, which requires the handler to inspect `event.origin` before processing the message.
- **No production impact:** Both changes are in test files only.

## User Operation Scenarios

1. Developer runs `npx vitest run` — all tests pass including the modified `inject-extension-token.test.ts`
2. CI runs CodeQL scan on the branch — alerts #112 and #113 no longer appear
3. Developer runs `npx next build` — production build succeeds
