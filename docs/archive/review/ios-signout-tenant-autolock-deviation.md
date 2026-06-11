# Coding Deviation Log: ios-signout-tenant-autolock

## D1 — Shared bounds constant placed in `Shared` (`AutoLockLimits`), not `AppSettingsStore`
The plan (C3) suggested `VAULT_AUTO_LOCK_MIN/MAX` as `AppSettingsStore` static lets. But `LockState` (in the `Shared` framework) also needs the max for its clamp (F2), and `Shared` cannot import the host's `AppSettingsStore`. So the single source of truth lives in `Shared/Models/LockState.swift` as `enum AutoLockLimits { tenantMinMinutes=5; maxMinutes=1440; floorMinutes=1 }`, referenced by `LockState`, `AutoLockService`, and `AppSettingsStore` (which gained `import Shared`). Still a single shared const (R2 honored); just located in `Shared` for cross-target access.

## D2 — `applyTenantPolicy(_ value:…)` param named `value`, not `minutes`
The plan's signature used `_ minutes: Int?`, which would shadow the `minutes` property. Renamed to `_ value:` to avoid the shadow (same behavior).

## Verification
- `xcodebuild test` on iPhone 16 / iOS 18.2 simulator: **318 tests, 0 failures** (302 prior + 16 new). No compile errors/warnings.
- New tests: VaultUnlockData tenant decode (120/null/absent), UnlockResult threading (passphrase 120 / biometric nil), AppSettingsStore (applyTenantPolicy 3 branches, effective precedence, getter fail-closed for out-of-range/zero, clear, user-minutes-untouched), AutoLockService clamp (120→120, 2000→1440, 0→1), LockState clamp (120→120, 2000→1440).
- Catalog: 4 new keys (Sign Out, dialog title/message, "Set by your organization.") with ja; LocalizationCatalogTests green. No IDE stale-marker churn.
- No iOS-26-only API; deployment target 17.0 → CI Xcode 16.4 / iOS 18 SDK compatible.
- No new files → no xcodegen/pbxproj change.
