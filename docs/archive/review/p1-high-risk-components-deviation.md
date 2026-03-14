# Coding Deviation Log: p1-high-risk-components
Created: 2026-03-14

## Deviations from Plan

### DEV-01: Phase 8a — `finalizeUnlock()` helper not extracted

- **Plan description**: Phase 8a required extracting a `finalizeUnlock()` helper inside `vault-context.tsx` to deduplicate the identical finalization code shared by `unlock`, `unlockWithPasskey`, and `unlockWithStoredPrf` (write refs, derive ECDH keys, set encryptionKey, set status, call EA auto-confirm).
- **Actual implementation**: No `finalizeUnlock()` helper was extracted. The three unlock functions each still call `confirmPendingEmergencyGrants()` inline and set state independently. The split proceeded without pre-split deduplication of finalization logic.
- **Reason**: The split was achievable without this refactoring — `confirmPendingEmergencyGrants` was made a standalone module-level export from `emergency-access-context.tsx` and imported back into `vault-context.tsx`, which satisfies the architectural goal. The `finalizeUnlock()` extraction was a "reduce coupling before splitting" step that turned out to be unnecessary given the chosen approach for EA integration.
- **Impact scope**: Internal to `vault-context.tsx`. The three unlock paths remain separately coded rather than sharing a helper. `vault-context.tsx` is 833 lines (reduced from 954), not the further reduction that `finalizeUnlock()` extraction would have achieved.

---

### DEV-02: Phase 8a — `lock()` not refactored to accept ECDH cleanup callback

- **Plan description**: Phase 8a required refactoring `lock()` to accept cleanup callbacks, in preparation for separating ECDH ref ownership after the split.
- **Actual implementation**: `lock()` was not refactored to accept callbacks. ECDH refs remained in `vault-context.tsx` and `lock()` continues to zero them directly. The pre-split refactoring step was skipped.
- **Reason**: After splitting AutoLock and EmergencyAccess out of `vault-context.tsx`, all ECDH refs stayed in `vault-context.tsx` alongside `lock()`, making the callback pattern unnecessary. The plan's Considerations section had already identified this: "lock() must zero both secretKeyRef and ecdhPrivateKeyBytesRef. After split, ECDH refs stay in VaultUnlockContext, so lock() remains in the same file. No cross-context zero issue."
- **Impact scope**: No behavioral change. `lock()` implementation unchanged.

---

### DEV-03: Phase 8b — `hiddenLockMinutes` prop not passed to `AutoLockProvider`

- **Plan description**: The plan specified `AutoLockProvider` would receive both `autoLockMinutes: number` and `hiddenLockMinutes: number` as props from `VaultUnlockContext`.
- **Actual implementation**: `AutoLockProvider` receives only `autoLockMinutes: number | null`. The `hiddenLockMinutes` value is not a prop — `AutoLockProvider` computes the hidden timeout internally as `Math.min(autoLockMinutes * 60_000, DEFAULT_HIDDEN_TIMEOUT_MS)`. The vault status API response does not expose a separate `hiddenLockMinutes` field, so VaultUnlockContext only stores `autoLockMinutes` state.
- **Reason**: The API response (`/api/vault/status`) returns `vaultAutoLockMinutes` as a single timeout. There is no separate hidden-lock configuration field in the data model, making the `hiddenLockMinutes` prop impractical. `AutoLockProvider` derives the hidden timeout from `autoLockMinutes` using a capped default, which is simpler and avoids a prop that has no backing data source.
- **Impact scope**: `AutoLockProvider` interface has one prop instead of two. Behavior is functionally equivalent — hidden lock timeout is still configurable, just derived rather than prop-driven.

---

### DEV-04: Phase 8c — `confirmPendingEmergencyGrants` kept as shared module-level export; inline calls in unlock functions not removed

- **Plan description**: Phase 8c described moving `confirmPendingEmergencyGrants()` into `emergency-access-context.tsx` and having EmergencyAccessContext own the interval. The plan noted two options for the "inline call at unlock time" problem and preferred: "keep `confirmPendingEmergencyGrants()` as a standalone module-level function and call it from both VaultUnlockContext (inline after unlock) and EmergencyAccessContext (interval)."
- **Actual implementation**: This "preferred" approach was implemented. `confirmPendingEmergencyGrants` is exported from `emergency-access-context.tsx` as a standalone async function. `vault-context.tsx` imports and calls it directly in all three unlock paths. `EmergencyAccessProvider` also runs it on an interval and on `visibilitychange`/`online` events.
- **Reason**: Consistent with the plan's preferred option. No deviation in intent — the plan itself described this as the "simpler" approach.
- **Impact scope**: Not a deviation from intent; included for completeness. Both files reference the function.

---

### DEV-05: Item 9 — `RevealableField` shared component not extracted (Phase 9c)

- **Plan description**: Phase 9c specified extracting a `RevealableField` component — the repeated pattern of show/hide + copy button — as a shared utility for use across all section components.
- **Actual implementation**: No `RevealableField` component was created. Each section component directly renders its own show/hide toggle (Eye/EyeOff icons) and `CopyButton` inline. The repeated pattern exists across sections but was not abstracted.
- **Reason**: Not recorded. The extraction was likely omitted to reduce scope or because the per-section variation in layout and labels made a generic component harder to parameterize.
- **Impact scope**: Minor duplication across section files. No behavioral impact. Phase 9c's `InlineDetailData` move was completed correctly.

---

### DEV-06: Item 8 — `auto-lock-context.test.tsx` and `emergency-access-context.test.tsx` not created

- **Plan description**: The Testing Strategy section required new test files: `auto-lock-context.test.tsx` (timer fires after inactivity, visibility change handling, cleanup on unmount) and `emergency-access-context.test.tsx` (auto-confirm interval fires, cleanup on unmount, `inFlight` guard prevents concurrent calls).
- **Actual implementation**: Neither test file was created. The only test update for Item 8 was adding mock stubs for `AutoLockProvider` and `EmergencyAccessProvider` to the existing `vault-context-loading-timeout.test.tsx`.
- **Reason**: Not recorded. May have been deferred due to complexity of mocking browser APIs (timers, visibility, online events) and the `renderHook` setup required.
- **Impact scope**: Auto-lock and emergency-access context logic has no dedicated unit tests. The `inFlight` guard in `EmergencyAccessProvider` and the activity-check interval in `AutoLockProvider` are untested in isolation.
