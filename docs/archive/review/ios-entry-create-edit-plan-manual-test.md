# Manual Test Plan: iOS entry create + edit

Device-only verification for the SwiftUI + AutoFill paths the unit tests cannot exercise (R35 Tier-1). The pure crypto/round-trip logic is covered by `PersonalEntryBlobBuilderTests` and the view-model tests; this artifact covers wire-up, biometric, sync, and AutoFill visibility.

## Pre-conditions
- A real iPhone (Simulator AutoFill config is unreliable — see [[ios-autofill-host-entitlement]]).
- Signed in, vault unlocked, with `<test-vault>` containing at least one personal LOGIN entry that has **2 tags AND a TOTP secret** (create it in the web app first so the tag colors + totp object exist server-side).
- The passwd-sso AutoFill provider enabled in iOS Settings → Passwords → Password Options.
- Server reachable; the worker/sync path healthy.

## Scenario 1 — Create a new LOGIN
- Steps: vault list → tap `+` → enter title "GitHub", username `<test-user>`, password, url `https://github.com`, leave TOTP blank → Save.
- Expected: form dismisses without error; after the post-save sync the entry "GitHub" appears in the list exactly **once** (no duplicate); opening it shows the password.
- Expected (AutoFill): in Safari on a github.com login field, the QuickType bar offers the GitHub passwd-sso entry; selecting it → Face ID → fills.

## Scenario 2 — Edit preserves tags + TOTP (the regression lock)
- Steps: open the pre-condition entry (2 tags + TOTP) → Edit → change ONLY the password → Save.
- Expected: the entry **stays in the list** (does not vanish); re-open it — the TOTP one-time code still renders and rotates; load the same entry in the web app — both tags still present with their original colors, generator settings intact.
- Rollback: if the entry vanishes or loses tags/TOTP, the round-trip is broken — do not ship; edits should route to the web app until fixed.

## Scenario 3 — Clear TOTP
- Steps: edit an entry that has a TOTP → blank the TOTP Secret field → Save.
- Expected: the entry's One-Time Code section disappears; the AutoFill one-time-code picker no longer lists it; other fields intact.

## Scenario 4 — Legacy aadVersion 0 upgrade
- Pre-condition: an entry created before AAD binding shipped (`aadVersion: 0`), if one exists in `<test-vault>`.
- Steps: edit any field → Save.
- Expected: save succeeds; the entry decrypts cleanly afterward (now `aadVersion: 1`); no vanish.

## Scenario 5 — Team entry blocked
- Steps: switch to a team filter → confirm the `+` button is hidden; open a team entry → Edit → Save.
- Expected: `+` absent under team filter; team entry edit surfaces a "team edit not supported" error, no write.

## Adversarial / edge
- Create with empty username/url/notes (only title + password) → succeeds; entry shows blank optional fields.
- Lock the vault mid-edit (background past auto-lock) then Save → surfaces a cache/key-unavailable error rather than writing a corrupt blob.
- Airplane mode → Save → network error surfaced; no partial/duplicate entry after reconnect + sync.
