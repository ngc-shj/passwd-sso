# PasswdSSOAutofillExtension

Planned iOS AutoFill credential provider extension target.

Expected responsibilities:

- participate in iOS Password AutoFill flows
- return matching username/password credentials
- provide TOTP values where supported
- provide passkey assertions and passkey registration (creation)
- react safely to locked, expired-session, and no-match states
- rely on `Shared/` for crypto, models, matching, and storage adapters

## Passkey registration notes

### No-lockout invariant

`completeRegistrationRequest` is reachable from exactly ONE place, gated by the
pure `passkeyRegistrationOutcome` decision (Shared/AutoFill/
PasskeyRegistrationOutcome.swift): the credential is returned to the relying
party only after `POST /api/passwords` confirmed a durable save with a matching
entry id. Every other branch (unsupported algorithm, locked vault, crypto
failure, missing/expired upload token, network failure, id mismatch) cancels,
and iOS falls through to iCloud Keychain — the user is never left with an
RP-side credential whose private key was lost.

### signCount

A freshly registered passkey is stored with `passkeySignCount: 0`. The shipped
`PasskeySignCountStore` seeds from that floor, so the FIRST assertion emits
counter 1 (`testFirstUseEmitsFloorPlusOne`) and RP monotonicity checks pass
from the first use, including offline streaks on this device.

### Orphaned server entries (upload succeeds, completion fails)

If the process dies (or the OS rejects the completion) AFTER the server
confirmed the upload but BEFORE the RP received the credential, a PASSKEY entry
exists server-side that no RP account references. This is NOT a lockout: the
RP never saw the credential, so the user simply re-registers (creating a new
entry). The orphan is harmless E2E-encrypted key material the user can delete
from the vault list manually; a dedicated "delete unused passkeys" cleanup view
is a tracked follow-up.
