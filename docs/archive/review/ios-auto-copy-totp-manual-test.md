# Manual Test: ios-auto-copy-totp

Security-sensitive (AutoFill credential-fill path). Run on a real device or simulator with a synced
vault containing at least one LOGIN entry that has a TOTP secret.

## Pre-conditions
- Server URL configured, signed in, vault unlocked at least once (AutoFill cache populated).
- A LOGIN entry `<totp-login>` with a TOTP secret; a second LOGIN entry `<plain-login>` without TOTP.
- passwd-sso enabled under Settings → Passwords → Password Options as an AutoFill provider.

## Steps / Expected

1. **Default is OFF.** Fresh install (or after deleting the app): open Settings → Clipboard. "Auto-copy
   TOTP after fill" is **off**. → Fill `<totp-login>` in Safari; the clipboard does NOT contain the TOTP
   (paste into Notes shows nothing new).
2. **Enable + picker fill.** Turn the toggle ON. In Safari, tap the AutoFill key icon, choose
   `<totp-login>` from the list (picker path). → username/password fill; paste into the 2FA field shows
   the current 6-digit code; it matches the code shown in the app's entry detail.
3. **QuickType direct fill.** On a form where iOS shows `<totp-login>` directly above the keyboard, tap
   it (single-credential `prepareInterfaceToProvideCredential` path). → TOTP is also copied (both paths).
4. **No TOTP entry.** Fill `<plain-login>`. → nothing copied; no error.
5. **Auto-clear.** After a copy, wait `clipboardClearSeconds` (Settings → Clipboard → Auto-Clear). →
   pasting afterward yields nothing (clipboard expired).
6. **Non-default TOTP params.** If available, an entry with an 8-digit / SHA256 TOTP → the copied code
   matches the app's displayed code (param fidelity).

## Adversarial
- **Foreground-app clipboard read.** With the toggle ON, after a fill the calling app foregrounds and
  could read `UIPasteboard`. Confirm the exposure is bounded: the value is `.localOnly` (Step 7) and
  expires (Step 5). This is why the default is OFF (opt-in).
- **Universal Clipboard.** With Handoff enabled and a second Apple device on the same iCloud account,
  after a copy the TOTP does NOT appear in the other device's clipboard (`.localOnly: true`).
- **Setting tamper.** N/A by design — the setting is a non-secret App Group bool; toggling it OFF
  immediately stops copying on the next fill.

## Rollback
Revert the branch / disable the toggle. No persisted state beyond the `autoCopyTotp` App Group bool
(absent → OFF). No server-side change.
