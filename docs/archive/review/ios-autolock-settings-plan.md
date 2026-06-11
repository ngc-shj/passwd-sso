# Plan: iOS configurable auto-lock timeout + longer default

## Project context
- Type: `mixed` — native iOS host app (security-sensitive: governs when the vault auto-locks, which
  deletes bridge_key and thus gates AutoFill availability).
- Test infrastructure: `unit tests only` (PasswdSSOTests; AutoLockServiceTests exists). The
  service/persistence logic IS unit-testable; the SwiftUI settings screen is verified manually.

## Problem (confirmed by code)
AutoFill very frequently shows "Vault is Locked" because the host app's auto-lock deletes bridge_key
([AutoLockService.lock](ios/PasswdSSOApp/Vault/AutoLockService.swift) → `bridgeKeyStore.delete()`),
and the timeout is **hardcoded at 5 minutes** with **no settings UI** (`_autoLockMinutes = 5`; the
setter is only used by tests). Since every fill already requires Face ID
(`readForFill` uses `reuseDuration = 0`), the 5-minute host-app idle lock is overly aggressive for
AutoFill. There is NO background-lock (the scenePhase handler only re-syncs on `.active`); the lock
is purely the idle timer.

## Design alignment: match the browser extension (user-directed)
The Chrome extension already solved this exact problem and the same S1 concern. Its auto-lock picker
([extension/src/options/App.tsx](extension/src/options/App.tsx), [storage.ts](extension/src/lib/storage.ts)):
- Fixed options **5 / 15 / 30 / 60 minutes**, default **15**.
- **NO "Never"** — explicit code comment: *"No 'never' option: local vault must auto-lock within the
  same window as extension token / session idle timeout to avoid 'logged out but locally decryptable'
  states. Minimum 5 minutes (same as server-side VAULT_AUTO_LOCK_MIN)."*
- Minimum 5 (server-side `VAULT_AUTO_LOCK_MIN`); `ensureAutoLockAtLeastMin` clamps on read.

iOS mirrors this exactly. **This fully resolves security finding S1** (no unbounded host-UI unlock)
and removes the `autoLockDisabled` flag / three-representation complexity (F2/F10) entirely.

## Objective
1. Add a Settings screen to choose the auto-lock timeout: **5 / 15 / 30 / 60 minutes** (matching the
   extension; no "Never").
2. Persist the choice (App Group UserDefaults) so it survives relaunch, clamped to **[5, 60]** on read
   (fail-closed to 15 for absent/garbage — resolves S3).
3. Raise the default from 5 → **15 minutes** (matches the extension default).

## Requirements
Functional:
- The chosen timeout takes effect immediately on the live `AutoLockService` and is restored on next
  unlock.
- Default (no stored preference) = 15 minutes; stored values outside [5,60] are clamped on read.

Non-functional / security:
- No "Never" → no unbounded host-UI unlock (S1 resolved by matching the extension).
- The existing `autoLockMinutes` setter clamp `[1,60]` and `LockStateReducer` are UNCHANGED (the store
  enforces the stricter [5,60] above the service, so no service-test churn). No `autoLockDisabled`
  flag is introduced.

## Contracts

### C1 — Persistence store (locked)
- New `AutoLockSettingsStore` (App target) over `UserDefaults(suiteName: "group.jp.jpng.passwd-sso.shared")`
  (same suite as ServerURLSetupView/DeviceIdentifier), injectable for tests.
- Stored key `autoLockMinutes` (Int). Allowed range **[5, 60]**; **absent → 15**.
- API: `var minutes: Int { get set }`. Getter **fail-closes** (S3): distinguish absent (→15) from a
  stored value via `object(forKey:) == nil`; any stored/garbage value outside [5,60] clamps into
  [5,60]. Setter clamps to [5,60] on write.
- Acceptance (unit, T3): absent key reads 15; write 30 → read 30; write 100 → read 60; write 1 → read
  5; a second store instance over the same suite reads the persisted value (proves UserDefaults hit).
- **Consumer-flow walkthrough**:
  - Consumers `RootView.handleVaultUnlocked` AND `RootView.handleDebugVaultLoaded` (F5 — BOTH sites)
    read `store.minutes` and set `service.autoLockMinutes = store.minutes` BEFORE `startTimer()`. A
    shared helper `applyPersistedTimeout(to:from:)` guarantees parity across the two sites.
  - Consumer `SettingsView` reads `store.minutes` for the current selection and writes on change.
  - No consumer needs a field absent from the store.

### C2 — AutoLockService default 15 (locked)
- Default `_autoLockMinutes` changes `5 → 15`. NO `autoLockDisabled` flag (no "Never").
- `autoLockMinutes` setter clamp `[1,60]` UNCHANGED (the store enforces the stricter [5,60] above it).
  `tick()`, `LockStateReducer`, `LockState` UNCHANGED except the default.
- Testability (T2): make `tick()` `internal` (was `private`) and add a `clock:` param to the test
  `makeService` helper so the elapsed-lock path is deterministic. Tests must `stopTimer()` before
  calling `tick()` manually (the live 1s `Foundation.Timer` else races).
- Acceptance (unit): a directly-constructed `AutoLockService` has `_autoLockMinutes == 15` (T1);
  with a `TestClock`, `minutes=15`, advance `15*60`, `tick()` → `.locked` + bridge_key deleted;
  advance `15*60 - 1`, `tick()` → still `.unlocked` (off-by-one guard). Existing clamp/reducer tests
  stay green untouched (T4).
- Forbidden patterns:
  - `pattern: _autoLockMinutes: Int = 5` — reason: default must be 15 now.

### C3 — Settings screen + entry point (locked)
- New `SettingsView` (App): a `Form` with a `Picker` "Auto-Lock" → **5 / 15 / 30 / 60 minutes** (no
  Never), bound to the live `AutoLockService` + persisted via `AutoLockSettingsStore`. Footer note:
  the idle window after which the vault locks (AutoFill needs the app unlocked within it). No
  scary-Never caveat needed.
- Binding (F1/F2): `SettingsView` holds the service as `let autoLockService` (or `@Bindable`); the
  `Picker(selection:)` binds to an explicit `Binding<Int>` whose setter does, in order:
  `service.autoLockMinutes = v` → `store.minutes = v` → `service.recordActivity()` (F6 — reset idle
  on change so shortening the window mid-settings doesn't insta-lock). Getter returns the live
  `service.autoLockMinutes`.
- Entry point: a gear `ToolbarItem` at `.navigationBarLeading` in `VaultListView` (F9 — keep it away
  from the destructive trailing Lock button) presents `SettingsView` as a sheet. Presenting calls
  `autoLockService.recordActivity()` (F7 — so reading settings doesn't auto-lock from under the sheet).
- Acceptance: build clean; manual — changing the timeout and re-locking reflects the new value;
  relaunch restores it.

### C4 — No regression (locked)
- `xcodegen generate` + `build-for-testing` + `test-without-building` pass; existing AutoLockService
  clamp + reducer tests stay green; new store + disabled-tick tests added. No new warnings.

## Testing strategy
- Unit: `AutoLockSettingsStore` round-trip + default-15 + never(0) (in-memory `UserDefaults(suiteName:)`
  with a unique suite per test, removed in tearDown). `AutoLockService` — disabled tick does not lock;
  default is 15. Extend existing AutoLockServiceTests.
- Manual: settings screen interaction, persistence across relaunch, and on-device AutoFill staying
  available for the chosen window.

## Considerations & constraints
- Security: "Never" is opt-in with a UI caveat; default stays conservative-ish at 15 min (industry
  norm for password managers is 1–15 min app-lock). Per-fill biometric is unchanged.
- `LockStateReducer` appears parallel to the live `tick()` path (tick does not call `reduce`); this
  plan does NOT touch it to avoid scope creep — flagged so reviewers don't expect reducer changes.
- The setting lives in the App Group suite but is only consumed by the host app; no extension change.

## User operation scenarios
- Unlock → open Settings (gear) → pick "30 minutes" → AutoFill stays available for 30 min idle.
- Pick "Never" → AutoFill stays available until the user taps Lock or signs out.
- Relaunch the app → the chosen timeout persists.

## Addendum — settings parity with the browser extension (user-directed)

Port the remaining iOS-meaningful settings from the extension's `StorageSchema`
([extension/src/lib/storage.ts](extension/src/lib/storage.ts)) into the same Settings screen. Exact
options/defaults mirror the extension. Browser-only settings (`showBadgeCount`, `enableContextMenu`)
are N/A on iOS; `showSavePrompt`/`showUpdatePrompt`/`enableInlineSuggestions`/`autoCopyTotp` are
tracked as separate larger efforts (OS-mechanism differences).

### C5 — Vault timeout action (lock / logout) (locked)
- `enum VaultTimeoutAction: String { case lock, logout }`, default `.lock` (matches extension).
- Stored in `AppSettingsStore` (rename of `AutoLockSettingsStore`); `AutoLockService` gains a
  `timeoutAction` property applied at unlock sites alongside `autoLockMinutes`. `tick()` at the idle
  boundary calls `lock()` when `.lock`, `signOut()` when `.logout`.
- Acceptance (unit): with `.logout`, a boundary tick calls signOut (tokens + cache + wrapped keys
  cleared, bridge_key deleted); with `.lock`, it calls lock (bridge_key deleted, tokens/cache kept).
  Default is `.lock`.

### C6 — Clipboard auto-clear seconds (locked)
- `clipboardClearSeconds` from the extension's fixed options **[10, 20, 30, 60, 120, 300]**, default
  **30** (extension default; iOS currently hardcodes 60). Stored in `AppSettingsStore`, clamped to
  the nearest valid option, absent → 30.
- Consumers: `EntryDetailView.copySecurely` and `TOTPCodeView.copyToClipboard` read
  `AppSettingsStore().clipboardClearSeconds` for the pasteboard `expirationDate` (replacing the
  hardcoded 60).
- Acceptance (unit): store round-trip + default-30 + invalid→30; the copy sites use the stored value.

### C7 — Theme (system / light / dark) (locked)
- `enum AppTheme: String { case system, light, dark }`, default `.system` (matches extension).
- Applied app-wide reactively via `@AppStorage("appTheme", store: <app-group suite>)` in
  `PasswdSSOAppApp` → `.preferredColorScheme(theme.colorScheme)` (system → nil). SettingsView's theme
  Picker binds the same `@AppStorage` so changes apply live without relaunch.
- Acceptance: build clean; manual — switching theme updates the UI immediately and persists.

### C8 — AppSettingsStore rename + SettingsView sections (locked)
- `AutoLockSettingsStore` → `AppSettingsStore` holding `autoLockMinutes`, `vaultTimeoutAction`,
  `clipboardClearSeconds` (theme via `@AppStorage`). Existing autoLock tests updated to the new name.
- SettingsView grows three more rows: Vault timeout action (Lock/Logout), Clipboard auto-clear
  (10/20/30/60/120/300 s), Theme (System/Light/Dark). RootView applies `autoLockMinutes` +
  `timeoutAction` at both unlock sites.

## Go/No-Go Gate
| ID  | Subject                                          | Status |
|-----|--------------------------------------------------|--------|
| C1  | AutoLockSettingsStore (persist, default 15)      | locked |
| C2  | AutoLockService "never" flag + default 15        | locked |
| C3  | SettingsView + VaultListView gear entry          | locked |
| C4  | No build/test regression                         | locked |
