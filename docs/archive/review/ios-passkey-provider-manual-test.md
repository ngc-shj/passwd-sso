# Manual Test Plan: ios-passkey-provider

Auth-flow + deployment-surface change (project.yml `ProvidesPasskeys`, AutoFill
credential-provider passkey assertion). Device testing required — the AutoFill
passkey APIs cannot be exercised in unit tests or the simulator's AutoFill UI.

## Pre-conditions

- A real iPhone (iOS 17+) signed into a passwd-sso account, vault unlocked at least once.
- passwd-sso enabled under Settings → General → AutoFill & Passwords (as a source).
- At least one **passkey created via the browser extension** for a real RP (e.g.
  `webauthn.io`) and synced to the account. Use placeholder/test accounts only — do
  NOT record real personal emails/handles in this doc (RS4).
- A second authenticator available (iCloud Keychain) for the fallthrough scenarios.

## Steps (happy path — assertion)

1. On the iPhone, open Safari → `https://webauthn.io` (or the RP where the passkey
   was created). Choose "Authenticate" / sign in with a passkey.
2. Expected: the system passkey sheet lists the passwd-sso passkey for that RP.
3. Select it → Face ID prompt → the RP reports a successful sign-in.

## Expected result

- The passkey appears in the system passkey sheet (QuickType identity registered).
- After Face ID, the assertion verifies at the RP and sign-in succeeds.
- After locking the vault (or app background/launch), the passkey no longer appears
  in the sheet (identities cleared on the same lifecycle as password QuickType).

## Rollback

- Revert the branch (no schema/migration changes; cache format is backward
  compatible — old caches decode `entryType`/passkey fields as nil). Removing
  `ProvidesPasskeys` from project.yml + regenerating the project restores the
  prior password/TOTP-only provider behavior.

## Adversarial scenarios (Tier-2: auth flow)

1. **signCount monotonicity (C7 known limitation)**: sign in via the browser
   extension first (RP counter becomes non-zero), then attempt iOS assertion.
   Record whether the RP accepts (most do) or rejects (strict-monotonic RPs may,
   because iOS emits 0). Confirm passwd-sso's own RP accepts. Document the result.
2. **Team-entry routing**: ensure no crash/hang if a team entry id ever reaches the
   passkey path — expected clean failure (team passkeys out of scope; `entryNotFound`).
3. **Lock race**: lock the vault between opening the passkey sheet and tapping the
   entry. Expected: the locked sheet / a clean cancel, no cryptic error.
4. **Multi-provider**: have BOTH passwd-sso and iCloud Keychain hold a passkey for
   the same RP. Expected: both listed distinctly; selecting passwd-sso's works; no
   cross-contamination of credential IDs.
5. **Registration fallthrough (C8)**: attempt to CREATE a new passkey on the iPhone
   with passwd-sso selectable. Expected: passwd-sso does not produce a
   stored-but-unsaveable credential and does not hang — the user can complete
   creation with another provider (e.g. iCloud Keychain). passwd-sso must NEVER
   return an ASPasskeyRegistrationCredential (would lock the user out).
6. **Regression**: confirm password AutoFill and TOTP (one-time-code) fills still
   work unchanged on a normal login form.
