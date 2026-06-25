# Manual Test Plan: iOS Demo Mode (R35 Tier-1 — UI surface)

Covers the paths automated tests cannot exercise (per the plan's two-filter rule):
the on-device UI walkthrough, the iPad-compatibility render (VEC1), and the NFR1
runtime residue invariant against a REAL shared App Group container (the unit
grep gate proves the demo *source* references no shared-state symbol; only this
manual check proves the running app leaves a real user's vault untouched).

Automated coverage already verifies (excluded here per Filter A): the 9-entry
decrypt, per-type detail decode, TOTP secret, NFR3 reserved domains, ephemeral
key, and the source-level forbidden-symbol grep gate (`DemoVaultFactoryTests`,
`DemoModeStateTests`).

## Pre-conditions
- A simulator or device with the app installed from this branch.
- For the residue check (steps 6-8): a SECOND, real (non-demo) vault already set
  up and synced on the same simulator/device — sign in to the demo server
  (`https://www.jpng.jp/passwd-sso`) with the review account, unlock the vault so
  the shared cache file + QuickType identities exist, then sign out to `.setup`.
  (Operator-supplied credentials — substitute locally; do not commit.)

## Steps & Expected results

### A. Discoverability + render (VEC1 — run on an iPad simulator in iPhone-compat mode)
1. Cold-launch the app → lands on the server-URL screen (`.setup`).
   - **Expected**: a "Try Demo Mode" button is visible without entering a URL.
2. Tap "Try Demo Mode".
   - **Expected**: the demo vault opens; a "Demo Mode" chip is visible; the
     category grid shows "All" + one card per present type (Logins, Credit Cards,
     Identities, Passkeys, Secure Notes, Bank Accounts, Software Licenses, SSH Keys).
3. (iPad) Confirm the layout renders correctly in iPhone-compatibility (scaled)
   mode — no clipped/blank screen.
   - **Expected**: usable layout; the grid and rows render.

### B. Browse all 8 types + TOTP (FR2)
4. Open one entry of EACH type and confirm type-correct fields:
   - Logins → "AWS Console (IAM)": username, password (reveal), URL, One-Time Code.
   - Credit Cards → "Corporate VISA": brand/number/expiry/CVV.
   - Identities → "Alice Identity": full name / contact fields.
   - Passkeys → "GitHub Passkey": relying party.
   - Secure Notes → "VPN Recovery Notes": note content.
   - Bank Accounts → "Acme Savings": bank/account fields.
   - Software Licenses → "Adobe License": license key.
   - SSH Keys → "Deploy Key": public key + fingerprint.
   - **Expected**: each shows its own field set (NOT a login layout); no "Edit"
     button (read-only); no decrypt error.
5. On "AWS Console (IAM)", tap the One-Time Code copy and confirm a rotating
   6-digit code displays; search "ssh" and confirm "Deploy Key" appears.
   - **Expected**: TOTP code renders/copies; search filters live.

### C. Exit + NFR1 residue (the invariant only this plan can verify at runtime)
6. Before entering demo (or from the real-vault baseline in Pre-conditions),
   record: (a) the shared cache file mtime + size, (b) the favicon cache dir
   state, (c) the OS QuickType identity count. On a simulator:
   - cache: `~/Library/Developer/CoreSimulator/Devices/<UDID>/data/Containers/Shared/AppGroup/<group-UDID>/vault/encryptedEntries.cache`
   - favicon dir: `…/vault/favicon-cache/`
   - QuickType: Settings → Passwords → AutoFill (or `ASCredentialIdentityStore` count via a debug build).
   - **Destructive — operator-only**: none; this step is read-only inspection.
7. Enter demo, browse several entries (steps 2-5), then tap "Exit Demo".
   - **Expected**: returns to the server-URL screen (`.setup`).
8. Re-inspect the three values from step 6.
   - **Expected (NFR1)**: cache file mtime + size UNCHANGED; favicon-cache dir
     UNCHANGED (no new demo-host favicons); QuickType identity count UNCHANGED
     (demo entries did NOT register as OS suggestions).
9. Sign back into the real vault.
   - **Expected**: the real vault unlocks unchanged; entry count + settings
     (auto-lock, language, favicon opt-in) unchanged.

## Rollback
No persistent changes are made by demo. If any residue is observed in step 8,
that is a NFR1 failure — file a bug; no rollback needed (the demo wrote nothing
it can roll back). To clear an unrelated dirty simulator state, erase the
simulator (`xcrun simctl erase <UDID>`) — operator-only, destroys all sim data.

## Notes
- VEC2 (real App Store review acceptance): blocked-deferred — verifiable only by
  re-submission. See plan §Verification environment constraints.
- VEC3 (QuickType positive path): blocked-deferred — simulator Settings cannot
  select a third-party AutoFill provider. The negative invariant (demo registers
  NO identities) is covered by step 8 + the source grep gate.

## Execution record
_Append actual results inline after running (date / device / pass-fail per step)._
