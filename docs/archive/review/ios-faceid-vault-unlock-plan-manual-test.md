# Manual Test Plan: iOS Face ID vault unlock

Device-only verification for the SwiftUI + LAContext + keychain paths the unit tests can't exercise (R35 Tier-2: this changes session lifecycle + biometric key custody). Pure crypto/unwrap + lock-lifetime logic are covered by `VaultUnlockerTests`/`AutoLockServiceTests`; this artifact covers the biometric prompt, lock-survival, and the adversarial scenarios.

## Pre-conditions
- A real iPhone with Face ID (or Touch ID) enrolled (Simulator biometrics are unreliable; see [[ios-autofill-host-entitlement]]).
- Signed in, vault unlocked once with the master passphrase (this creates the `bridge_key` + `wrapped-vault-key.json`).
- Auto-lock timeout set to a short value (e.g. 1 min) with timeout action = "Lock" (not "Log Out").

## Scenario 1 — Auto-lock → Face ID re-unlock
- Steps: unlock with passphrase → leave the app idle past the auto-lock timeout → return to the app.
- Expected: the vault-locked screen appears AND the Face ID sheet prompts automatically; success → vault unlocked, list shown, NO passphrase typed.

## Scenario 2 — Manual Lock → Face ID re-unlock
- Steps: tap the Lock button → on the locked screen tap "Unlock with Face ID" (or it auto-prompts) → authenticate.
- Expected: unlocked without passphrase.

## Scenario 3 — Biometric cancel → passphrase fallback
- Steps: on the locked screen, cancel the Face ID prompt.
- Expected: no scary error; the passphrase field is present and usable; typing the passphrase unlocks. The "Unlock with Face ID" button re-triggers the prompt.

## Scenario 4 — Sign out → no biometric offered
- Steps: sign out (or set timeout action = "Log Out" and let it fire) → relaunch.
- Expected: the app routes to sign-in (not the locked screen); after re-sign-in the locked screen offers passphrase only until the first passphrase unlock recreates the bridge_key. Face ID is NOT offered while signed out.

## Scenario 5 — AutoFill works while host is locked (accepted behavior shift)
- Steps: unlock once, then auto-lock the host → in Safari, tap a saved login field → use the passwd-sso AutoFill provider.
- Expected: AutoFill fills (per-fill Face ID), even though the host shows "locked" — because the bridge_key survives the lock. (QuickType inline suggestions remain cleared on lock; the manual provider picker works.)

## Adversarial scenarios (Tier-2)
- **Biometric enrollment change**: after unlocking once, add or remove a Face/fingerprint enrollment in iOS Settings → return to passwd-sso and try Face ID unlock. Expected: the `.biometryCurrentSet` ACL has invalidated the bridge_key → biometric unlock fails → passphrase required (re-establishes trust). Verify the vault is NOT accessible via the now-invalidated biometric.
- **Coerced biometric (documented risk, not a bug)**: confirm that the accepted trade-off holds — after auto-lock, a held face/finger unlocks the vault without the passphrase. This is the chosen 1Password/Bitwarden model; users wanting passphrase-every-time use timeout action = "Log Out".
- **Partial sign-out / crash safety**: trigger sign-out; confirm that after sign-out NEITHER the bridge_key NOR the wrapped key remains (biometric unlock unavailable). (Code: `signOut()` deletes the bridge_key as its first statement.)
- **No-cache / first-run**: fresh install, sign in, before the first passphrase unlock → confirm Face ID is NOT offered (no bridge_key / wrapped key yet).
- **Empty/unreadable cache**: (hard to force manually) — if the cache header userId can't be recovered, biometric unlock falls back to passphrase rather than unlocking with a bad userId.

## Rollback
If biometric unlock misbehaves, the passphrase path is always present on the locked screen; setting timeout action = "Log Out" reverts to full passphrase + re-sign-in on every timeout.
