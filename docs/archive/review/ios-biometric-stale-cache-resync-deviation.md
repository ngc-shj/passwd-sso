# Coding Deviation Log: ios-biometric-stale-cache-resync

## D1 — biometricUnlockError signature refinement (Minor, non-behavioral)
- Plan C2 sketched `biometricUnlockError(from: Error?, syncFailedCacheless: Bool) -> String?`.
- Implemented as `biometricUnlockError(from:syncFailedCacheless:message:)` with a
  `message: @autoclosure () -> String` param, so the localized string is injected by
  the caller (RootView, via L10n.string) rather than hardcoded in the pure function.
- Reason: keeps the pure function free of the i18n/`L10n` dependency so it stays a
  plain unit-testable free function (tests pass a literal "msg"). No behavioral change;
  the mapping logic (nil on .biometricFailed, message otherwise / on cacheless failure)
  is exactly as specified.

## D2 — emptyCacheData / syncedKeyVersion extracted as private RootView helpers (Minor)
- Plan C5 described the keyVersion re-derivation and empty-cache synthesis inline.
- Implemented as two private helpers (`emptyCacheData(userId:)`, `syncedKeyVersion(from:)`)
  for readability. `syncedKeyVersion` reuses the same `max(1, first{teamId==nil}?.keyVersion ?? 1)`
  idiom as VaultUnlocker (3rd copy of a one-line pattern; left un-extracted per YAGNI —
  the three sites are in different modules/contexts). No behavioral change.
