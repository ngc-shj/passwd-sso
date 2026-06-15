# Manual Test Plan: iOS team-entry AutoFill + QuickType + in-app team vault

Device-only verification for the team-key pipeline (R35 **Tier-2** — cryptographic-material handling: account
ECDH key, team keys). The crypto chain and resilience branches are covered by golden-vector unit tests
(`TeamKeyCryptoTests`, `HostSyncServiceTests`, `CredentialResolverTests`, `CredentialIdentityRegistrarTests`);
this artifact covers what unit tests cannot: real key lifecycle across unlock/sync/background, AutoFill
visibility, the in-app vault switcher, and the security-sensitive teardown/revocation paths.

Plan: [[ios-team-quicktype-plan]]. Note this branch also carries a **server change** (proxy Bearer-bypass
allowlist gains `/api/teams` — deviation D1), so the **server must be redeployed** before device testing or every
`/api/teams/*` call from the iOS token will 401.

## Pre-conditions
- A real iPhone (Simulator AutoFill config is unreliable — see [[ios-autofill-host-entitlement]]).
- The server build that includes the `/api/teams` proxy allowlist change is deployed and reachable.
- A **team** exists in the web app with a **distributed key**, and the device's account is a confirmed member
  with the team key distributed to it (verify in the web app: the member shows "key confirmed", not "pending").
- The team contains at least one LOGIN entry for a real site (e.g. `https://github.com`), ideally **two**: one
  with `itemKeyVersion == 0` and one with `itemKeyVersion >= 1` (per-entry ItemKey), so both crypto paths are
  exercised. Create them in the web app.
- The account also has ≥1 **personal** LOGIN entry (to prove scope separation).
- Signed in on device; vault unlocked **with passphrase at least once** (ECDH key is persisted only at the
  passphrase path — biometric-only unlock cannot seed it).
- The passwd-sso AutoFill provider enabled in iOS Settings → Passwords → Password Options (host + extension
  entitlement both present — [[ios-autofill-host-entitlement]]).

## Scenario 1 — Team entry fills via AutoFill (QuickType + picker)
- Steps: passphrase-unlock the app → background it (let a sync complete; wait a few seconds) → open Safari on the
  team site's login form.
- Expected (QuickType): the team LOGIN appears as a QuickType suggestion in the keyboard bar; selecting it →
  Face ID → fills username + password correctly.
- Expected (picker): tapping the passwords key → the AutoFill list includes the team entry under the team; Face
  ID-gated; fills correctly.
- Repeat for the `itemKeyVersion >= 1` entry — it must fill identically (guards the item-enc HKDF step, D2).

## Scenario 2 — In-app team vault display + switcher (C10)
- Steps: open the app (vault unlocked) → observe the top vault switcher.
- Expected: a segmented switcher shows **個人 (Personal)** + each team's name. Selecting a team scopes the
  category grid + list to that team only; team entries appear ONLY under their team, personal entries ONLY under
  個人 (no mixing). Category counts reflect the selected scope.
- Expected (create guard): under a team scope the `+` (create) button is hidden; the existing
  `teamEditNotSupported` guard remains the backstop if reached.
- Expected (cold start): force-quit and relaunch, unlock → the switcher still shows correct team names (proves
  `TeamDirectoryStore` persisted + decrypts the labels).

## Scenario 3 — Personal-only account unchanged (no regression)
- Pre-condition: an account on **no team** (or with no distributed key).
- Steps: unlock → sync → use AutoFill on a personal-site login.
- Expected: no vault switcher shown; personal entries fill exactly as before; **no errors** in logs about
  missing ECDH/team keys; sync completes normally.

## Scenario 4 — Background-only (biometric) refresh keeps team fill alive
- Pre-condition: passphrase-unlocked once (ECDH key persisted), then app backgrounded long enough that the next
  unlock is biometric.
- Steps: leave the app backgrounded across a background-sync cycle (do not passphrase-unlock again).
- Expected: team entries still fill after a background refresh (the persisted ECDH key re-derives team keys
  without a secretKey). The 15-min staleness self-refreshes on each sync.

## Adversarial / security scenarios (R35 Tier-2 — the unit tests do NOT cover these)
1. **Revocation latency**: in the web app, remove the device's membership (or rotate the team key without
   redistributing). On device, do NOT unlock again. Within **≤15 min** the stale team key is refused → team
   entries stop appearing in QuickType and stop filling; personal entries unaffected. (The bound is the 15-min
   `teamKeyMaxAge`; verify it does NOT keep filling indefinitely.)
2. **Sign-out wipes key material**: sign out. Using a file inspector / debugger on the App Group container,
   confirm BOTH `vault/wrapped-ecdh-private-key.json` AND `vault/wrapped-team-keys.json` (and
   `vault/team-directory.json`) are **deleted** (clearAll). Re-launch → no team entries until a fresh passphrase
   unlock + sync. (Guards the security-downgrade / leftover-key-material risk, S4/S10.)
3. **Clock skew**: set the device clock **back ~30 min**. Confirm previously-stale team keys do NOT re-appear as
   valid (staleness compares against the wrap's `issuedAt`; turning the clock back must not resurrect a key).
   Reset the clock afterward.
4. **Cross-tenant / unauthorized teamId**: with a token whose membership does not cover a given team (or after
   revocation), confirm `/api/teams/{id}/member-key` yields no usable key and the team simply does not appear —
   no other team's entries leak, no crash. (Server authorization is the primary control; this verifies the
   client degrades to "team absent" rather than erroring or cross-filling.)

## Rollback
If any of the following occur, do **not** ship and disable the team path (the personal flow is independent and
must keep working):
- team entries fill but are invisible in-app (the C10 switcher half-state the plan explicitly closed), or
- a team entry fails to decrypt/fill (especially the `itemKeyVersion >= 1` case — indicates the item-enc HKDF
  regression D2 reappeared), or
- sign-out leaves any `wrapped-ecdh-private-key.json` / team-key / team-directory file on disk, or
- revoked membership keeps filling past the 15-min bound, or
- a personal-only account sees errors, a spurious switcher, or broken personal fill (regression).
