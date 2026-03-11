# Plan: beforeunload-dirty-state

## Objective

Replace the global beforeunload guard (which fires on every page navigation while the vault is unlocked) with targeted dirty-state guards that only fire when the user would actually lose unsaved work. This improves UX by removing unnecessary confirmation dialogs while preserving data-loss protection where it matters.

## Requirements

### Functional
1. Remove global beforeunload handler and keyboard shortcut blocker from `vault-context.tsx`
2. Remove `SKIP_BEFOREUNLOAD_ONCE_KEY` / `ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY` skip mechanisms (no longer needed)
3. Clean up references in `signout-button.tsx` and `auto-extension-connect.tsx` (including dead code in handleCloseTab and ALLOW useEffect)
4. Add `useBeforeUnloadGuard(dirty: boolean)` hook for reuse across components
5. Integrate the hook into:
   - Password import (`password-import.tsx`) — guard when `importing || encryptedFile !== null || (entries.length > 0 && !done)`
   - Personal entry forms (page variant only) — guard when `!isDialogVariant && hasChanges`
6. Watchtower already has its own guard — leave it unchanged
7. Team forms are dialog-only — no guard needed

### Non-functional
- No UX regressions: dirty forms must still be guarded
- No security regressions: vault lock-on-reload is acceptable (by design)
- All tests must pass, production build must succeed

## Technical Approach

### New hook: `src/hooks/use-before-unload-guard.ts`

```ts
import { useEffect } from "react";

export function useBeforeUnloadGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
```

### Entry forms integration

Personal entry forms already compute `hasChanges` and `isDialogVariant`. Add:

```ts
useBeforeUnloadGuard(!isDialogVariant && hasChanges);
```

Team forms are dialog-only (no page variant) — excluded from scope.

### Import integration

In `password-import.tsx` (`ImportPanelContent`):

```ts
// Guard during: encrypted file decryption input, preview with parsed entries, active import
useBeforeUnloadGuard(importing || encryptedFile !== null || (entries.length > 0 && !done));
```

## Implementation Steps

1. Create `src/hooks/use-before-unload-guard.ts`
2. Remove global guard from `src/lib/vault-context.tsx` (lines ~289-327, `SKIP_BEFOREUNLOAD_ONCE_KEY`, `ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY` constants)
3. Clean up `src/components/auth/signout-button.tsx` — remove `sessionStorage.setItem("psso:skip-beforeunload-once", "1")` try-catch block
4. Clean up `src/components/extension/auto-extension-connect.tsx`:
   - Remove `SKIP_BEFOREUNLOAD_ONCE_KEY` and `ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY` constants
   - Remove `sessionStorage.setItem(SKIP_BEFOREUNLOAD_ONCE_KEY, "1")` from `handleCloseTab` (keep `window.close()`)
   - Remove the `useEffect` that sets/clears `ALLOW_BEFOREUNLOAD_WHILE_CONNECTED_KEY` in sessionStorage
5. Update `docs/security/considerations/en.md` and `ja.md` — remove `psso:skip-beforeunload-once` from sessionStorage section, document dirty-state guard approach
6. Add `useBeforeUnloadGuard` to `src/components/passwords/password-import.tsx`
7. Add `useBeforeUnloadGuard` to personal entry forms (page variant only): `personal-login-form.tsx`, `personal-secure-note-form.tsx`, `personal-identity-form.tsx`, `personal-bank-account-form.tsx`, `personal-credit-card-form.tsx`, `personal-ssh-key-form.tsx`, `personal-software-license-form.tsx`, `personal-passkey-form.tsx`
8. Write unit test for `useBeforeUnloadGuard` hook
9. Run `npx vitest run` and `npx next build`

## Testing Strategy

### Unit test for `useBeforeUnloadGuard` (`src/hooks/use-before-unload-guard.test.ts`)
- (a) `dirty = false` initial state — `addEventListener` is NOT called
- (b) `dirty` changes `false -> true` — `addEventListener` is called
- (c) `dirty` changes `true -> false` — `removeEventListener` is called (no listener leak)
- (d) Unmount while `dirty = true` — `removeEventListener` is called (cleanup)
- (e) Handler calls `e.preventDefault()` and sets `e.returnValue = ""` when fired

### Existing tests
- Must continue to pass (no behavioral changes to form logic)

### Manual verification
- Reload during import shows browser dialog; reload on clean form does not

## Considerations & Constraints

- **Watchtower**: Already has its own beforeunload + SPA link interception pattern — leave unchanged
- **SPA navigation (reviewed, out of scope)**: Next.js App Router `<Link>` / `router.push` do not fire `beforeunload`. Adding SPA navigation guards is a separate concern and out of scope. The `hasChanges` badge provides visual feedback.
- **Keyboard shortcut blocking (reviewed, not needed)**: The original guard blocked F5/Ctrl+R at keydown level. With `beforeunload`, the browser natively shows a confirmation dialog, which is sufficient.
- **Stray references audit**: All references audited via grep — 5 files: `vault-context.tsx`, `signout-button.tsx`, `auto-extension-connect.tsx`, 2 security doc files. All cleaned up.
- **Team forms (reviewed, excluded)**: Team forms are dialog-only (no page variant). They use `TeamEntryDialogShell` and have no `variant` prop. Excluded from scope per "dialog variants don't need it" principle.
- **Import done state**: When `done === true`, guard is removed. Data is already server-side, so no loss risk. Will add code comment.
- **Lint error**: User mentioned unused-local-variable lint error (line 51, test file) — won't fix, separate cleanup
