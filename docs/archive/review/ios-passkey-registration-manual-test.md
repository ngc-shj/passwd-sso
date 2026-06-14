# Manual Test Plan: ios-passkey-registration

R35 Tier-2 (auth flow + crypto + project.yml `ProvidesPasskeyRegistration`).
Device testing required — passkey registration cannot be exercised in unit
tests or the simulator's AutoFill UI.

## Pre-conditions

- A real iPhone (iOS 17+) signed into a passwd-sso account; vault unlocked in
  the host app within the last few minutes (the upload token's server TTL is
  5 min — foregrounding the host app re-mints it).
- passwd-sso enabled under Settings → General → AutoFill & Passwords.
- The server running this branch (`IOS_AUTOFILL` clientKind + `POST
  /api/mobile/autofill-token` deployed and migrated).
- iCloud Keychain available as the fall-through provider.
- Use placeholder/test accounts only — do NOT record real personal
  emails/handles in this doc (RS4).
- A second device (or browser-extension install) on the same account for the
  sync scenario.

## Steps (happy path — register, then immediately authenticate)

> The happy path doubles as the **cross-process Keychain round-trip check
> (R25)**: the upload token is WRITTEN by the host process
> (AutofillTokenRefresher → UploadTokenStore) and READ by the AutoFill
> extension process — a boundary unit tests cannot cross (both targets mock
> the Keychain in-process). A registration that reaches the network proves
> host-written `com.passwd-sso.upload-token` items are visible to the
> extension via the shared default access group.

1. Foreground the passwd-sso host app (unlock if prompted), then open Safari →
   `https://webauthn.io`, enter a test username, tap "Register".
2. Expected: the system sheet offers saving the passkey with passwd-sso;
   Face ID prompt comes from the passwd-sso extension.
3. Expected: webauthn.io reports successful registration; the new PASSKEY
   entry appears in the host app's vault list (already present WITHOUT a
   manual re-sync — the extension appends it to the local cache).
4. On the same page tap "Authenticate".
5. Expected: the passwd-sso passkey is offered and the assertion succeeds
   (signCount starts at 0; the first assertion emits 1).
6. On the SECOND device (after a sync), authenticate at webauthn.io with the
   same passkey. Expected: success (blob shape is extension-compatible).

## Adversarial scenarios (T8 — must all fall through cleanly)

- **Airplane mode after the RP "create" tap**: enable Link Conditioner 100%
  loss (or airplane mode) right after tapping Register and selecting
  passwd-sso. Expected: passwd-sso cancels after the upload attempt; iOS falls
  through (offer iCloud Keychain); webauthn.io shows NO orphaned credential
  for passwd-sso (a later "Authenticate" must not offer a passwd-sso passkey
  that cannot sign).
- **Missing token**: lock the vault in the host app (or delete the
  `com.passwd-sso.upload-token` Keychain item via a debug build), then
  register. Expected: immediate cancel → iCloud Keychain fall-through, no
  Face ID double-prompt loop.
- **Expired token**: wait > 5 min after the last host-app foreground, then
  register without foregrounding the host. Expected: cancel + fall-through
  (loadValid treats the expired token as absent).
- **Post-upload kill**: not deterministically scriptable; if observed (e.g.
  crash between upload and completion), expected state is an unused PASSKEY
  entry server-side and NO credential at the RP. Re-registering must succeed;
  the orphan entry is deletable from the vault list.
- **Log hygiene**: while registering, stream Console.app filtered to
  subsystem `jp.jpng.passwd-sso`. Expected: branch/diagnostic lines only — no
  JWK, no private-key material, no token value, no DPoP proof body.

## Expected result

All happy-path steps pass; every adversarial scenario ends in a clean cancel
with iCloud Keychain offered, and no RP-side credential exists unless the
server confirmed the matching entry id.

## Rollback

Revert the branch (server + iOS). The `ProvidesPasskeyRegistration` capability
disappears with the build; already-created PASSKEY entries remain valid vault
entries (assertion path is unchanged and shipped). Minted `IOS_AUTOFILL`
tokens expire within 5 minutes; revoke early via the extension-token admin
surface if needed.
