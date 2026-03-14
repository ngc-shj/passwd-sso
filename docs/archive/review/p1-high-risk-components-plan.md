# Plan: P1 High-Risk Components (Items 8, 9)

## Objective

Decompose two large, high-risk components that were deferred from the P1 structural batch:
- **Item 8**: Split `vault-context.tsx` (954 lines, 31 direct importers) into focused providers
- **Item 9**: Decompose `password-detail-inline.tsx` (1,258 lines, 13 reveal timeouts) into entry-type sub-components

Also includes: commit unstaged `team-entry-save.test.ts` from the P1 batch.

---

## Requirements

### Functional
1. **Item 8**: Split VaultContext into 3 providers: VaultUnlockContext (core), AutoLockContext (timer), EmergencyAccessContext (EA auto-confirm). Preserve all 31 consumer imports.
2. **Item 9**: Extract `useRevealTimeout` hook and per-entry-type detail sections. Reduce `password-detail-inline.tsx` from 1,258 to ~300 lines.
3. Zero behavior change — all existing tests must pass, no UI regressions.

### Non-Functional
1. `npx vitest run` and `npx next build` must pass
2. All existing imports must continue working (re-exports where needed)
3. Provider nesting order must be correct (VaultUnlock → AutoLock → EmergencyAccess → TeamVault)

---

## Technical Approach

### Item 8: Split VaultContext

Based on analysis, vault-context.tsx has 5 logical groups with 6 coupling points.

#### Split Strategy

**Phase 8a: Pre-split refactoring (reduce coupling)**

Before splitting files, refactor within `vault-context.tsx`:
1. Extract `finalizeUnlock()` helper — the 3 unlock functions (unlock, unlockWithPasskey, unlockWithStoredPrf) share identical finalization code: write refs, derive ECDH keys, set encryptionKey, set status, call EA auto-confirm
2. Extract `lock()` into a standalone function that accepts cleanup callbacks — currently it zeroes secretKeyRef + ecdhPrivateKeyBytesRef directly
3. Move `autoLockMsRef`/`hiddenLockMsRef` initialization out of Effect-1 (vault status fetch) into a callback pattern

**Phase 8b: Extract AutoLockContext**

Lowest risk split — auto-lock timer has the fewest coupling points.

Create `src/lib/auto-lock-context.tsx`:
- Owns: `lastActivityRef`, `hiddenAtRef`, `autoLockMsRef`, `hiddenLockMsRef`
- Owns: Effect-3 (activity listeners + 30s interval check)
- Receives from parent via props: `vaultStatus`, `lock()` callback, `autoLockMinutes: number`, `hiddenLockMinutes: number` (values, not refs — props-down pattern, simplest React data flow)
- Exports: `AutoLockProvider`, `useAutoLock` (currently no consumers need this directly)
- VaultUnlockContext stores timeout values as state (from `/api/vault/status` response) and passes them as props

**Phase 8c: Extract EmergencyAccessContext**

Create `src/lib/emergency-access-context.tsx`:
- Owns: Effect-4 (2-minute EA auto-confirm interval)
- Owns: `confirmPendingEmergencyGrants()` function (move from module-level)
- Receives from parent: `vaultStatus`, `getSecretKey()`, `keyVersion: number` (value, not ref), `userId`
- Exports: `EmergencyAccessProvider` (no direct consumer hooks needed — it's self-contained)

**Phase 8d: Slim down VaultUnlockContext**

What remains in `vault-context.tsx` (renamed conceptually to VaultUnlockContext):
- State: `vaultStatus`, `encryptionKey`, `hasRecoveryKey`
- Refs: `secretKeyRef`, `keyVersionRef`, `accountSaltRef`, `wrappedKeyRef`, `ecdhPrivateKeyBytesRef`, `ecdhPublicKeyJwkRef`, `updateRef`
- Effects: Effect-1 (vault status fetch), Effect-2 (LOADING timeout), Effect-5 (pagehide zero)
- Functions: `unlock`, `unlockWithPasskey`, `unlockWithStoredPrf`, `setup`, `changePassphrase`, `verifyPassphrase`, `lock`, `getSecretKey`, `getAccountSalt`, `getEcdhPrivateKeyBytes`, `getEcdhPublicKeyJwk`
- Renders: `<AutoLockProvider>` → `<EmergencyAccessProvider>` → `<TeamVaultProvider>` → `{children}`

**Provider nesting (in VaultProvider render):**
```
<VaultContext.Provider>
  <AutoLockProvider vaultStatus={status} lock={lock} setTimeouts={setTimeouts}>
    <EmergencyAccessProvider vaultStatus={status} getSecretKey={getSecretKey} keyVersion={keyVersionRef.current} userId={session?.user?.id}>
      <TeamVaultProvider ...>
        {children}
      </TeamVaultProvider>
    </EmergencyAccessProvider>
  </AutoLockProvider>
</VaultContext.Provider>
```

#### Consumer migration

No consumer migration needed — all 31 importers use `useVault()` which returns `VaultContextValue` from the core context. AutoLock and EA contexts have no external consumers.

### Item 9: Decompose password-detail-inline.tsx

#### Split Strategy

**Phase 9a: Extract `useRevealTimeout` hook**

Create `src/hooks/use-reveal-timeout.ts`:
```typescript
import type { RequireVerificationFn } from "@/hooks/use-reprompt";

function useRevealTimeout(
  requireVerification: RequireVerificationFn,
  entryId: string,
  requireReprompt: boolean,
): { revealed: boolean; handleReveal: () => void }
```
- Encapsulates: `useState(false)`, `setTimeout(() => set(false), REVEAL_TIMEOUT_MS)`, `requireVerification` wrapper
- **Timer cleanup**: Use `useRef<ReturnType<typeof setTimeout>>` (`timerRef`) to store the timeout ID. Call `clearTimeout(timerRef.current)` before each new `setTimeout` to prevent stale callbacks on rapid toggle. Add `useEffect(() => () => clearTimeout(timerRef.current), [])` for unmount cleanup.
- Replaces 11 identical `handleRevealXxx` + `showXxx` pairs
- Also create `useRevealSet` — independent hook (not built on `useRevealTimeout`) with `Map<number, ReturnType<typeof setTimeout>>` for per-index timers. Each index gets its own timer entry; cleanup iterates the map on unmount.

**Phase 9b: Extract entry-type detail sections**

Create one component per entry type in `src/components/passwords/detail-sections/`:
- `ssh-key-section.tsx` (~123 lines)
- `bank-account-section.tsx` (~156 lines)
- `software-license-section.tsx` (~99 lines)
- `passkey-section.tsx` (~88 lines)
- `identity-section.tsx` (~118 lines)
- `credit-card-section.tsx` (~103 lines)
- `secure-note-section.tsx` (~27 lines)
- `login-section.tsx` (~247 lines)

Each section:
- Receives `data: InlineDetailData` (or a Pick thereof)
- Uses `useRevealTimeout` internally for its own show* states
- Uses `useTranslations()` directly (not passed via props)
- Receives `requireVerification` and `createGuardedGetter` via props
- Does NOT call `useReprompt()` — reprompt state is owned by the parent orchestrator only. Parent calls `useReprompt()`, passes `requireVerification` and `createGuardedGetter` as props, and renders `repromptDialog` itself.

**Phase 9c: Extract shared utilities**

- `RevealableField` component — the repeated pattern of show/hide + copy button
- Move `InlineDetailData` to `src/types/entry.ts` (alongside `FullEntryData`)

**Phase 9d: Slim down parent component**

`password-detail-inline.tsx` becomes a thin orchestrator:
- `useReprompt()` call (sole owner of reprompt state)
- Renders `repromptDialog` from `useReprompt()`
- Entry type switch → render appropriate section component (passes `requireVerification` + `createGuardedGetter` as props)
- Attachments + timestamps footer (already extracted)

Target: ~200-300 lines.

---

## Implementation Steps

### Step 0: Include unstaged file
1. Add `src/lib/team-entry-save.test.ts` to the branch

### Step 1: Item 9 — Extract `useRevealTimeout` hook
1. Create `src/hooks/use-reveal-timeout.ts` with `useRevealTimeout` and `useRevealSet`
2. Add `src/hooks/use-reveal-timeout.test.ts`:
   - `useRevealTimeout`: reveal/hide cycle, unmount cleanup (clearTimeout called), rapid toggle (only last timer active), re-render stability
   - `useRevealSet`: multi-index independent timers (index 0 expires while index 2 still visible), stale-setTimeout prevention, unmount clears all map entries
3. Refactor `password-detail-inline.tsx` to use the new hook (replace 11 show* states + handlers)

### Step 2: Item 9 — Extract entry-type sections
1. Create `src/components/passwords/detail-sections/` directory
2. Extract each section, moving show* state into the section (via `useRevealTimeout`)
3. Update `password-detail-inline.tsx` to render sections via entry type switch

### Step 3: Item 9 — Move InlineDetailData type + update reprompt test
1. Move `InlineDetailData` from `password-detail-inline.tsx` to `src/types/entry.ts`
2. Update all 4 importers to use `@/types/entry`
3. Re-export from `password-detail-inline.tsx` for backward compatibility
4. Update `password-detail-inline-reprompt.test.ts` — the test uses `readFileSync` to count `handleReveal` occurrences (line ~32). After refactoring, the parent file will have fewer occurrences. Update the assertion target or switch to testing via the extracted section components.

### Step 4: Item 8 — Pre-split refactoring
1. Extract `finalizeUnlock()` helper within vault-context.tsx
2. Refactor `lock()` to accept ECDH cleanup callback
3. Verify tests still pass after internal refactoring

### Step 5: Item 8 — Extract AutoLockContext
1. Create `src/lib/auto-lock-context.tsx`
2. Move Effect-3 and related refs
3. Nest `<AutoLockProvider>` inside VaultProvider render

### Step 6: Item 8 — Extract EmergencyAccessContext
1. Create `src/lib/emergency-access-context.tsx`
2. Move Effect-4 and `confirmPendingEmergencyGrants()`
3. Nest `<EmergencyAccessProvider>` inside AutoLockProvider
4. **Secret key zeroing**: When `confirmPendingEmergencyGrants()` takes a snapshot copy of the secret key via `getSecretKey()`, zero the copy after use with `.finally(() => snapshot.fill(0))` to limit exposure window

### Step 7: Verification
1. Run `npx vitest run`
2. Run `npx next build`
3. Verify all 31 vault-context consumers still compile
4. Verify all 4 password-detail-inline importers still compile

---

## Testing Strategy

1. **Baseline**: All existing tests must pass without modification (except import path updates)
2. **New tests**:
   - `use-reveal-timeout.test.ts`: reveal/hide cycle, unmount during active timeout, rapid toggle, re-render stability
   - `auto-lock-context.test.tsx`: timer fires after inactivity, visibility change handling, cleanup on unmount (if feasible with renderHook)
   - `emergency-access-context.test.tsx`: auto-confirm interval fires, cleanup on unmount, `inFlight` guard prevents concurrent calls (second interval skipped while first request pending)
3. **Build verification**: `npx next build` catches SSR/import issues
4. **Existing test files**:
   - `vault-context-loading-timeout.test.tsx` — may need updated provider mocks if VaultProvider render tree changes (AutoLockProvider/EmergencyAccessProvider wrapping)
   - `vault-unlock-error.test.ts` — must pass unchanged
   - `password-detail-inline-reprompt.test.ts` — will need update: `readFileSync` assertion counting `handleReveal` occurrences will break after extraction to section components. Update assertion target or refactor test approach.

---

## Considerations & Constraints

- **Item 8 — `lock()` orchestration**: `lock()` must zero both `secretKeyRef` and `ecdhPrivateKeyBytesRef`. After split, ECDH refs stay in VaultUnlockContext, so `lock()` remains in the same file. No cross-context zero issue.
- **Item 8 — EA inline call**: The 3 unlock functions call `confirmPendingEmergencyGrants()` at the end. After split, this becomes a callback passed from EmergencyAccessContext, OR VaultUnlockContext emits an `onUnlockSuccess` event. Preferred approach: pass `onUnlockSuccess` callback from EmergencyAccessContext to VaultUnlockContext via React context composition (EA wraps inside Vault, so it can't provide to Vault directly). Solution: VaultUnlockContext accepts an `onUnlockSuccess` prop, EmergencyAccessContext passes it down. OR: keep `confirmPendingEmergencyGrants()` as a standalone module-level function (it only needs secretKey, userId, keyVersion as args) and call it from both VaultUnlockContext (inline after unlock) and EmergencyAccessContext (interval). This is simpler and avoids context coupling.
- **Item 8 — `autoLockMsRef` initialization**: Effect-1 fetches `/api/vault/status` and writes timeout values. After split, VaultUnlockContext stores timeout values as state (from the API response) and passes them as props to AutoLockProvider. AutoLockProvider converts to ms internally. No callback pattern needed — simple props-down data flow.
- **Item 8 — No consumer migration**: All 31 consumers use `useVault()` from the core context. AutoLock and EA have no external consumer hooks.
- **Item 9 — `requireVerification` sharing**: Only real cross-section shared state. Pass as props to each section component. Do NOT create a new Context for this.
- **Item 9 — `InlineDetailData` move**: Re-export from original file for backward compat.
- **Item 9 — Attachment state**: `attachments`/`teamAttachments` useState + useEffect stay in the parent orchestrator (they're not entry-type-specific).
- **Items 8, 9 are independent**: Can be implemented in parallel or either order. Item 9 is lower risk (1 consumer of the component), so implement first.
- **SSR safety**: All new context files (`auto-lock-context.tsx`, `emergency-access-context.tsx`) and hooks (`use-reveal-timeout.ts`) must include `"use client"` directive. Browser APIs (`window`, `document`, `setInterval`) are only used inside `useEffect` (already SSR-safe pattern).
- **Timer tests**: Use `vi.useFakeTimers()` and `vi.advanceTimersByTime()` for auto-lock and reveal timeout tests. Do NOT use real timers — they cause flaky tests.
- **Out of scope**: Playwright E2E tests (required for Item 8 Phase D per refactoring plan, but the split itself doesn't remove any functionality — just reorganizes code)
